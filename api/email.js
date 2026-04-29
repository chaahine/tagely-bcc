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
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'BCC Stagely <onboarding@resend.dev>',
        to: [to],
        subject,
        html
      })
    });

    const data = await response.json();
    if (data.error) return res.status(400).json({ success: false, error: data.error.message || data.error, data });
    return res.status(200).json({ success: true, data });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
