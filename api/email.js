export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { to, subject, html } = req.body;
  if (!to || !subject || !html) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': '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',
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
    if (data.code) return res.status(400).json({ success: false, error: data.message });
    return res.status(200).json({ success: true });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
