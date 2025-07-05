# Stripe Configuration
STRIPE_SECRET_KEY=sk_live_your_stripe_secret_key_here
STRIPE_ACC_NAME=Your Business Name Here

# Asana Configuration
ASANA_ACCESS_TOKEN=your_asana_personal_access_token_here
ASANA_PROJECT_ID=your_asana_project_id_here

# Email Configuration (SMTP)
SMTP_HOST=smtp.zeptomail.eu
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=emailapikey
SMTP_PASS=your_zeptomail_password_here
EMAIL_FROM=your_email@x.bueno.ltd
EMAIL_TO=recipient@example.com

# Schedule Configuration (Cron format)
# Default: Monday at 10:00 CET (0 10 * * 1)
# Format: minute hour day month dayOfWeek
# Examples:
# - Monday at 10:00: 0 10 * * 1
# - Tuesday at 10:00: 0 10 * * 2
# - Wednesday at 10:00: 0 10 * * 3
# - Thursday at 10:00: 0 10 * * 4
# - Friday at 10:00: 0 10 * * 5
CRON_SCHEDULE=0 10 * * 1
