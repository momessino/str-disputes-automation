const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const csv = require('csv-writer').createObjectCsvWriter;
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const axios = require('axios');

// Configuration from environment variables
const config = {
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
  },
  asana: {
    accessToken: process.env.ASANA_ACCESS_TOKEN,
    projectId: process.env.ASANA_PROJECT_ID,
  },
  email: {
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT || 587,
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.EMAIL_FROM,
    to: process.env.EMAIL_TO,
  },
  schedule: process.env.CRON_SCHEDULE || '0 10 * * 1', // Default: Monday at 10:00 CET
};

// Initialize Stripe
const stripe = new Stripe(config.stripe.secretKey);

// Risk scoring system
class RiskScorer {
  static calculateRiskScore(dispute) {
    let score = 0;
    const factors = [];

    // 1. Dispute Reason (30 points max)
    const reasonScores = {
      'fraudulent': 30,
      'unrecognized': 25,
      'duplicate': 15,
      'subscription_canceled': 10,
      'product_unacceptable': 8,
      'product_not_received': 6,
      'credit_not_processed': 5,
      'general': 3,
    };
    const reasonScore = reasonScores[dispute.reason] || 5;
    score += reasonScore;
    factors.push(`Reason: ${dispute.reason} (+${reasonScore})`);

    // 2. Amount (25 points max)
    const amount = dispute.amount / 100; // Convert from cents
    let amountScore = 0;
    if (amount >= 1000) amountScore = 25;
    else if (amount >= 500) amountScore = 20;
    else if (amount >= 200) amountScore = 15;
    else if (amount >= 100) amountScore = 10;
    else if (amount >= 50) amountScore = 5;
    else amountScore = 2;
    
    score += amountScore;
    factors.push(`Amount: $${amount} (+${amountScore})`);

    // 3. Customer History (20 points max)
    // Note: This would require additional Stripe API calls to get customer history
    // For now, we'll use charge creation date as a proxy
    const chargeDate = new Date(dispute.charge.created * 1000);
    const accountAge = (Date.now() - chargeDate.getTime()) / (1000 * 60 * 60 * 24); // days
    
    let customerScore = 0;
    if (accountAge < 1) customerScore = 20;
    else if (accountAge < 7) customerScore = 15;
    else if (accountAge < 30) customerScore = 10;
    else if (accountAge < 90) customerScore = 5;
    else customerScore = 2;
    
    score += customerScore;
    factors.push(`Customer age: ${Math.floor(accountAge)} days (+${customerScore})`);

    // 4. Timing (15 points max)
    const disputeDate = new Date(dispute.created * 1000);
    const timeBetween = (disputeDate.getTime() - chargeDate.getTime()) / (1000 * 60 * 60 * 24); // days
    
    let timingScore = 0;
    if (timeBetween < 1) timingScore = 15;
    else if (timeBetween < 3) timingScore = 12;
    else if (timeBetween < 7) timingScore = 8;
    else if (timeBetween < 14) timingScore = 5;
    else timingScore = 2;
    
    score += timingScore;
    factors.push(`Dispute timing: ${Math.floor(timeBetween)} days after charge (+${timingScore})`);

    // 5. Payment Method (10 points max)
    const paymentMethod = dispute.charge.payment_method_details?.card?.brand || 'unknown';
    const funding = dispute.charge.payment_method_details?.card?.funding || 'unknown';
    const country = dispute.charge.payment_method_details?.card?.country || 'unknown';
    
    let paymentScore = 0;
    if (funding === 'prepaid') paymentScore += 5;
    if (country !== 'US' && country !== 'CA' && country !== 'GB') paymentScore += 3;
    if (['discover', 'diners', 'jcb'].includes(paymentMethod)) paymentScore += 2;
    
    paymentScore = Math.min(paymentScore, 10);
    score += paymentScore;
    factors.push(`Payment: ${paymentMethod}/${funding}/${country} (+${paymentScore})`);

    return { score: Math.min(score, 100), factors };
  }

  static getRiskLevel(score) {
    if (score >= 80) return 'CRITICAL';
    if (score >= 60) return 'HIGH';
    if (score >= 40) return 'MEDIUM';
    if (score >= 20) return 'LOW';
    return 'MINIMAL';
  }

  static getRiskMeter(score) {
    const levels = {
      'MINIMAL': '🔵',
      'LOW': '🟢',
      'MEDIUM': '🟡',
      'HIGH': '🟠',
      'CRITICAL': '🔴'
    };
    
    const level = this.getRiskLevel(score);
    const filled = Math.floor(score / 10);
    const empty = 10 - filled;
    
    return `${levels[level]} [${'█'.repeat(filled)}${'░'.repeat(empty)}] ${score}%`;
  }
}

// Utility functions
function getWeekDateRange() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  
  const endDate = new Date(now);
  endDate.setDate(now.getDate() - daysToMonday);
  endDate.setHours(23, 59, 59, 999);
  
  const startDate = new Date(endDate);
  startDate.setDate(endDate.getDate() - 6);
  startDate.setHours(0, 0, 0, 0);
  
  return { startDate, endDate };
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function generateFileName(startDate, endDate) {
  return `${formatDate(endDate)} - ${formatDate(startDate)} disputes.csv`;
}

// Main functions
async function fetchDisputesFromStripe(startDate, endDate) {
  try {
    console.log(`Fetching disputes from ${formatDate(startDate)} to ${formatDate(endDate)}`);
    
    const disputes = await stripe.disputes.list({
      created: {
        gte: Math.floor(startDate.getTime() / 1000),
        lte: Math.floor(endDate.getTime() / 1000),
      },
      limit: 100,
    });

    console.log(`Found ${disputes.data.length} disputes`);
    return disputes.data;
  } catch (error) {
    console.error('Error fetching disputes from Stripe:', error);
    throw error;
  }
}

async function generateCSV(disputes, fileName) {
  try {
    const csvData = disputes.map(dispute => {
      const riskAnalysis = RiskScorer.calculateRiskScore(dispute);
      
      return {
        id: dispute.id,
        amount: (dispute.amount / 100).toFixed(2),
        currency: dispute.currency.toUpperCase(),
        reason: dispute.reason,
        status: dispute.status,
        created: new Date(dispute.created * 1000).toISOString().split('T')[0],
        charge_id: dispute.charge.id,
        customer_email: dispute.charge.billing_details?.email || 'N/A',
        customer_name: dispute.charge.billing_details?.name || 'N/A',
        payment_method: dispute.charge.payment_method_details?.card?.brand || 'N/A',
        risk_score: riskAnalysis.score,
        risk_level: RiskScorer.getRiskLevel(riskAnalysis.score),
        risk_meter: RiskScorer.getRiskMeter(riskAnalysis.score),
        risk_factors: riskAnalysis.factors.join('; '),
      };
    });

    // Sort by risk score (highest first)
    csvData.sort((a, b) => b.risk_score - a.risk_score);

    const csvWriter = csv({
      path: fileName,
      header: [
        { id: 'id', title: 'Dispute ID' },
        { id: 'amount', title: 'Amount' },
        { id: 'currency', title: 'Currency' },
        { id: 'reason', title: 'Reason' },
        { id: 'status', title: 'Status' },
        { id: 'created', title: 'Created Date' },
        { id: 'charge_id', title: 'Charge ID' },
        { id: 'customer_email', title: 'Customer Email' },
        { id: 'customer_name', title: 'Customer Name' },
        { id: 'payment_method', title: 'Payment Method' },
        { id: 'risk_score', title: 'Risk Score' },
        { id: 'risk_level', title: 'Risk Level' },
        { id: 'risk_meter', title: 'Risk Meter' },
        { id: 'risk_factors', title: 'Risk Factors' },
      ]
    });

    await csvWriter.writeRecords(csvData);
    console.log(`CSV file generated: ${fileName}`);
    return fileName;
  } catch (error) {
    console.error('Error generating CSV:', error);
    throw error;
  }
}

async function uploadToAsana(fileName, startDate, endDate) {
  try {
    const taskData = {
      data: {
        name: `Weekly Stripe Disputes Report - ${formatDate(startDate)} to ${formatDate(endDate)}`,
        notes: `Disputes report for the period ${formatDate(startDate)} – ${formatDate(endDate)}`,
        projects: [config.asana.projectId],
        due_on: formatDate(new Date()), // Due date is creation date
      }
    };

    // Create task
    const taskResponse = await axios.post(
      'https://app.asana.com/api/1.0/tasks',
      taskData,
      {
        headers: {
          'Authorization': `Bearer ${config.asana.accessToken}`,
          'Content-Type': 'application/json',
        }
      }
    );

    const taskId = taskResponse.data.data.gid;
    console.log(`Created Asana task: ${taskId}`);

    // Upload CSV as attachment
    const fileBuffer = await fs.readFile(fileName);
    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer]), fileName);
    formData.append('parent', taskId);

    await axios.post(
      'https://app.asana.com/api/1.0/attachments',
      formData,
      {
        headers: {
          'Authorization': `Bearer ${config.asana.accessToken}`,
        }
      }
    );

    console.log(`CSV uploaded to Asana task: ${taskId}`);
    return taskId;
  } catch (error) {
    console.error('Error uploading to Asana:', error);
    throw error;
  }
}

async function sendEmailNotification(fileName, startDate, endDate) {
  try {
    const transporter = nodemailer.createTransporter({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.secure,
      auth: {
        user: config.email.user,
        pass: config.email.pass,
      },
    });

    const mailOptions = {
      from: config.email.from,
      to: config.email.to,
      subject: 'Weekly Stripe Disputes Report',
      text: `Против Вас открыты следующие диспуты за период "${formatDate(startDate)} – ${formatDate(endDate)}"`,
      attachments: [
        {
          filename: path.basename(fileName),
          path: fileName,
        },
      ],
    };

    await transporter.sendMail(mailOptions);
    console.log('Email notification sent successfully');
  } catch (error) {
    console.error('Error sending email:', error);
    throw error;
  }
}

// Main execution function
async function runWeeklyReport() {
  const { startDate, endDate } = getWeekDateRange();
  const fileName = generateFileName(startDate, endDate);
  
  console.log('='.repeat(50));
  console.log(`Starting weekly disputes report: ${formatDate(startDate)} to ${formatDate(endDate)}`);
  console.log('='.repeat(50));

  try {
    // 1. Fetch disputes from Stripe
    const disputes = await fetchDisputesFromStripe(startDate, endDate);
    
    if (disputes.length === 0) {
      console.log('No disputes found for this period');
      return;
    }

    // 2. Generate CSV
    await generateCSV(disputes, fileName);

    // 3. Upload to Asana
    await uploadToAsana(fileName, startDate, endDate);

    // 4. Send email notification
    await sendEmailNotification(fileName, startDate, endDate);

    // 5. Clean up - remove local CSV file
    await fs.unlink(fileName);
    console.log('Local CSV file cleaned up');

    console.log('Weekly report completed successfully!');
  } catch (error) {
    console.error('Error in weekly report:', error);
    
    // Log error details for debugging
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString(),
    });
  }
}

// Schedule the task
console.log(`Scheduling weekly reports with cron: ${config.schedule}`);
cron.schedule(config.schedule, runWeeklyReport, {
  timezone: "Europe/Berlin" // CET timezone
});

// For testing purposes - uncomment to run immediately
// runWeeklyReport();

console.log('Stripe Disputes Automation started successfully!');
console.log('Next run will be according to schedule:', config.schedule);

// Keep the process alive
process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  process.exit(0);
});

// Export for testing
module.exports = { runWeeklyReport, RiskScorer };
