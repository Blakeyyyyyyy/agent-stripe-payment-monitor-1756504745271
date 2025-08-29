const express = require('express');
const Stripe = require('stripe');
const { google } = require('googleapis');
const Airtable = require('airtable');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

// Initialize APIs
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY });
const base = airtable.base('appUNIsu8KgvOlmi0');

// Gmail OAuth2 setup
const oauth2Client = new google.auth.OAuth2();
oauth2Client.setCredentials({
  access_token: process.env.GMAIL_ACCESS_TOKEN,
  refresh_token: process.env.GMAIL_REFRESH_TOKEN,
});

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

// Logging
let activityLogs = [];

function log(message, type = 'info') {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, message, type };
  console.log(`[${timestamp}] ${type.toUpperCase()}: ${message}`);
  activityLogs.push(logEntry);
  
  if (activityLogs.length > 100) {
    activityLogs = activityLogs.slice(-100);
  }
}

// Middleware
app.use(express.json());
app.use('/stripe-webhook', bodyParser.raw({ type: 'application/json' }));

// Send Gmail alert
async function sendGmailAlert(paymentData) {
  try {
    const subject = '🚨 Payment Failed Alert - Stripe';
    const htmlBody = `
      <h2 style="color: #d73a49;">Payment Failed Alert</h2>
      <p><strong>Payment ID:</strong> ${paymentData.id}</p>
      <p><strong>Amount:</strong> $${(paymentData.amount / 100).toFixed(2)} ${paymentData.currency?.toUpperCase()}</p>
      <p><strong>Customer:</strong> ${paymentData.customer_email || 'N/A'}</p>
      <p><strong>Failure Reason:</strong> ${paymentData.failure_reason || 'N/A'}</p>
      <p><strong>Time:</strong> ${new Date(paymentData.created * 1000).toLocaleString()}</p>
      <p><a href="https://dashboard.stripe.com/payments/${paymentData.id}">View in Stripe</a></p>
    `;

    const emailContent = [
      'Content-Type: text/html; charset=utf-8',
      'MIME-Version: 1.0',
      `Subject: ${subject}`,
      '',
      htmlBody
    ].join('\n');

    const encodedMessage = Buffer.from(emailContent)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedMessage }
    });

    log(`Gmail alert sent for payment ${paymentData.id}`, 'success');
  } catch (error) {
    log(`Failed to send Gmail: ${error.message}`, 'error');
  }
}

// Add to Airtable
async function addToAirtable(paymentData) {
  try {
    const record = await base('Failed Payments').create([{
      fields: {
        'Payment ID': paymentData.id,
        'Amount': (paymentData.amount / 100).toFixed(2),
        'Currency': paymentData.currency?.toUpperCase() || 'USD',
        'Customer Email': paymentData.customer_email || 'N/A',
        'Customer ID': paymentData.customer || 'N/A',
        'Failure Reason': paymentData.failure_reason || 'N/A',
        'Failure Code': paymentData.failure_code || 'N/A',
        'Failed At': new Date(paymentData.created * 1000).toISOString(),
        'Stripe URL': `https://dashboard.stripe.com/payments/${paymentData.id}`,
        'Status': 'Failed'
      }
    }]);

    log(`Added to Airtable: ${paymentData.id}`, 'success');
    return record;
  } catch (error) {
    log(`Airtable error: ${error.message}`, 'error');
  }
}

// Process failed payment
async function processFailedPayment(paymentData) {
  log(`Processing failed payment: ${paymentData.id}`, 'info');
  
  try {
    if (paymentData.customer) {
      try {
        const customer = await stripe.customers.retrieve(paymentData.customer);
        paymentData.customer_email = customer.email;
      } catch (err) {
        log(`Could not get customer: ${err.message}`, 'warn');
      }
    }

    await Promise.all([
      sendGmailAlert(paymentData),
      addToAirtable(paymentData)
    ]);

    log(`Successfully processed: ${paymentData.id}`, 'success');
  } catch (error) {
    log(`Processing error: ${error.message}`, 'error');
  }
}

// Routes
app.get('/', (req, res) => {
  res.json({
    service: 'Stripe Failed Payments Monitor',
    status: 'running',
    timestamp: new Date().toISOString(),
    endpoints: {
      'GET /': 'Service status',
      'GET /health': 'Health check',
      'GET /logs': 'Recent logs',
      'POST /test': 'Test processing',
      'POST /stripe-webhook': 'Stripe webhook'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    logs: activityLogs.length
  });
});

app.get('/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const recentLogs = activityLogs.slice(-limit).reverse();
  res.json({
    logs: recentLogs,
    total: activityLogs.length
  });
});

app.post('/test', async (req, res) => {
  try {
    log('Manual test triggered', 'info');

    const testData = {
      id: 'pi_test_' + Date.now(),
      amount: 2500,
      currency: 'usd',
      customer: 'cus_test',
      customer_email: 'test@example.com',
      failure_reason: 'insufficient_funds',
      failure_code: 'card_declined',
      created: Math.floor(Date.now() / 1000)
    };

    await processFailedPayment(testData);

    res.json({
      success: true,
      message: 'Test completed',
      data: testData
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    if (secret) {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    log(`Webhook error: ${err.message}`, 'error');
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  log(`Webhook received: ${event.type}`, 'info');

  if (event.type === 'payment_intent.payment_failed' || 
      event.type === 'charge.failed' || 
      event.type === 'invoice.payment_failed') {
    await processFailedPayment(event.data.object);
  }

  res.json({ received: true });
});

app.use((error, req, res, next) => {
  log(`Error: ${error.message}`, 'error');
  res.status(500).json({ error: error.message });
});

app.listen(port, () => {
  log(`Server started on port ${port}`, 'success');
});

module.exports = app;