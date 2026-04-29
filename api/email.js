export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { to, subject, html, apiKey } = req.body;
  if (!to || !subject || !html || !apiKey) {
    return res.status(400).json({ error: 'Paramètres manquants: to, subject, html, apiKey' });
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: 'BCC Stagely', email: 'chahinedjadel@gmail.com' },
        to: [{ email: to }],
        subject,
        htmlContent: html
      })
    });

    const data = await response.json();
    if (data.code) return res.status(400).json({ success: false, error: data.message, data });
    return res.status(200).json({ success: true, data });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
