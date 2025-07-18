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
    accountName: process.env.STRIPE_ACC_NAME || 'Stripe Account',
  },
  asana: {
    accessToken: process.env.ASANA_ACCESS_TOKEN,
    projectId: process.env.ASANA_PROJECT_ID,
    assigneeId: process.env.ASANA_ASSIGNEE_ID, // Optional - if not set, task won't be assigned
  },
  email: {
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT || 587,
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.EMAIL_FROM,
    to: process.env.EMAIL_TO,
    replyTo: process.env.EMAIL_REPLY_TO,
    bodyTemplate: process.env.EMAIL_BODY_TEMPLATE || `Добрый день,

Против Вас открыты следующие диспуты за период "{START_DATE} – {END_DATE}". См. вложенный файл.

Пришлите, пожалуйста, материалы для оспаривания в ответ на данное письмо.

Спасибо.`,
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
    
    // Get charge data - handle both expanded and non-expanded cases
    const charge = dispute.charge;
    if (!charge) {
      console.warn('No charge data available for dispute:', dispute.id);
      return { score: 50, factors: ['Insufficient data for risk analysis'] };
    }

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
    const currency = dispute.currency.toLowerCase();
    let amount;
    
    // Handle zero-decimal currencies properly
    const zeroDecimalCurrencies = ['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'];
    
    if (zeroDecimalCurrencies.includes(currency)) {
      amount = dispute.amount; // Already in major units
    } else {
      amount = dispute.amount / 100; // Convert from cents
    }
    
    let amountScore = 0;
    // Adjust thresholds based on currency (rough conversion for risk assessment)
    let threshold1000, threshold500, threshold200, threshold100, threshold50;
    
    if (currency === 'jpy' || currency === 'krw') {
      // Japanese Yen / Korean Won - much higher numbers
      threshold1000 = 100000; threshold500 = 50000; threshold200 = 20000; threshold100 = 10000; threshold50 = 5000;
    } else if (currency === 'hkd') {
      // Hong Kong Dollar - roughly 8:1 to USD
      threshold1000 = 8000; threshold500 = 4000; threshold200 = 1600; threshold100 = 800; threshold50 = 400;
    } else if (currency === 'eur' || currency === 'gbp') {
      // Euro/Pound - roughly similar to USD
      threshold1000 = 900; threshold500 = 450; threshold200 = 180; threshold100 = 90; threshold50 = 45;
    } else {
      // Default USD thresholds
      threshold1000 = 1000; threshold500 = 500; threshold200 = 200; threshold100 = 100; threshold50 = 50;
    }
    
    if (amount >= threshold1000) amountScore = 25;
    else if (amount >= threshold500) amountScore = 20;
    else if (amount >= threshold200) amountScore = 15;
    else if (amount >= threshold100) amountScore = 10;
    else if (amount >= threshold50) amountScore = 5;
    else amountScore = 2;
    
    score += amountScore;
    factors.push(`Amount: ${amount} ${currency.toUpperCase()} (+${amountScore})`);

    // 3. Customer History (20 points max)
    // Use charge creation date as proxy for customer age
    const chargeDate = new Date(charge.created * 1000);
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
    const paymentMethodDetails = charge.payment_method_details;
    const brand = paymentMethodDetails?.card?.brand || 'unknown';
    const funding = paymentMethodDetails?.card?.funding || 'unknown';
    const country = paymentMethodDetails?.card?.country || 'unknown';
    
    let paymentScore = 0;
    if (funding === 'prepaid') paymentScore += 5;
    if (country !== 'US' && country !== 'CA' && country !== 'GB') paymentScore += 3;
    if (['discover', 'diners', 'jcb'].includes(brand)) paymentScore += 2;
    
    paymentScore = Math.min(paymentScore, 10);
    score += paymentScore;
    factors.push(`Payment: ${brand}/${funding}/${country} (+${paymentScore})`);

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
  
  // Work with UTC dates to ensure consistency regardless of server timezone
  const nowUTC = new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayOfWeek = nowUTC.getUTCDay(); // 0 = Sunday, 1 = Monday, etc.
  
  // Calculate days to previous Sunday (for end date)
  const daysToSunday = dayOfWeek === 0 ? 7 : dayOfWeek; // If today is Sunday, go back 7 days to previous Sunday
  
  // Calculate end date (previous Sunday at 23:59:59.999 UTC)
  const endDate = new Date(nowUTC);
  endDate.setUTCDate(nowUTC.getUTCDate() - daysToSunday);
  endDate.setUTCHours(23, 59, 59, 999);
  
  // Calculate start date (Monday, 6 days before end date)
  const startDate = new Date(endDate);
  startDate.setUTCDate(endDate.getUTCDate() - 6);
  startDate.setUTCHours(0, 0, 0, 0);
  
  return { startDate, endDate };
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function generateFileName(startDate, endDate) {
  return `${formatDate(endDate)} - ${formatDate(startDate)} disputes for ${config.stripe.accountName}.csv`;
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
      expand: ['data.charge', 'data.charge.customer'],
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
      
      // Extract all the data that Stripe provides
      const charge = dispute.charge;
      const customer = charge?.customer;
      
      // Handle currency properly - don't convert, just format correctly
      const currency = dispute.currency.toLowerCase();
      let displayAmount;
      
      // Handle zero-decimal currencies (JPY, KRW, etc.) and regular currencies
      const zeroDecimalCurrencies = ['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'];
      
      if (zeroDecimalCurrencies.includes(currency)) {
        // Zero-decimal currencies: amount is already in major units
        displayAmount = dispute.amount.toString();
      } else {
        // Regular currencies: divide by 100 to convert from cents
        displayAmount = (dispute.amount / 100).toFixed(2);
      }
      
      return {
        id: dispute.id,
        dispute_created_utc: new Date(dispute.created * 1000).toISOString().replace('T', ' ').slice(0, 16), // Format: 2025-06-28 15:35
        dispute_amount: displayAmount,
        dispute_currency: currency,
        charge_id: charge?.id || 'N/A',
        customer_email: charge?.billing_details?.email || charge?.receipt_email || 'N/A',
        customer_id: typeof customer === 'string' ? customer : customer?.id || 'N/A',
        reason: dispute.reason,
        status: dispute.status,
        win_likelihood: dispute.balance_transactions?.[0]?.fee_details?.find(fee => fee.type === 'stripe_fee')?.amount ? 'N/A' : 'N/A', // This needs to be fetched separately
        payment_method_type: charge?.payment_method_details?.type || 'N/A',
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
        { id: 'id', title: 'id' },
        { id: 'dispute_created_utc', title: 'Dispute Created (UTC)' },
        { id: 'dispute_amount', title: 'Dispute Amount' },
        { id: 'dispute_currency', title: 'Dispute Currency' },
        { id: 'charge_id', title: 'Charge ID' },
        { id: 'customer_email', title: 'Customer Email' },
        { id: 'customer_id', title: 'Customer ID' },
        { id: 'reason', title: 'Reason' },
        { id: 'status', title: 'Status' },
        { id: 'win_likelihood', title: 'Win Likelihood' },
        { id: 'payment_method_type', title: 'Payment Method Type' },
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
        name: `Disputes Report for ${config.stripe.accountName}, ${formatDate(startDate)} – ${formatDate(endDate)}`,
        notes: `Disputes report for the period ${formatDate(startDate)} – ${formatDate(endDate)}`,
        projects: [config.asana.projectId],
        due_on: formatDate(new Date()), // Due date is creation date
      }
    };

    // Add assignee if specified
    if (config.asana.assigneeId) {
      taskData.data.assignee = config.asana.assigneeId;
      console.log(`Assigning task to user: ${config.asana.assigneeId}`);
    }

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
    
    // Log assignment status
    if (config.asana.assigneeId) {
      console.log(`Task successfully assigned to user: ${config.asana.assigneeId}`);
    } else {
      console.log('Task created without assignee (ASANA_ASSIGNEE_ID not configured)');
    }

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
    if (error.response?.data) {
      console.error('Asana API error details:', error.response.data);
    }
    throw error;
  }
}

async function sendEmailNotification(fileName, startDate, endDate) {
  try {
    const transporter = nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.secure,
      auth: {
        user: config.email.user,
        pass: config.email.pass,
      },
    });

    // Process email body template with date substitution
    const emailBody = config.email.bodyTemplate
      .replace(/{START_DATE}/g, formatDate(startDate))
      .replace(/{END_DATE}/g, formatDate(endDate))
      .replace(/\\n/g, '\n'); // Handle escaped newlines from environment variables

    const mailOptions = {
      from: config.email.from,
      to: config.email.to,
      replyTo: config.email.replyTo,
      subject: `Weekly Disputes Report for ${config.stripe.accountName}`,
      text: emailBody,
      attachments: [
        {
          filename: path.basename(fileName),
          path: fileName,
        },
      ],
    };

    await transporter.sendMail(mailOptions);
    console.log('Email notification sent successfully');
    console.log(`Reply-To address: ${config.email.replyTo || 'Not configured'}`);
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
  console.log(`Account: ${config.stripe.accountName}`);
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
