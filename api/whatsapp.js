export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { to, text, token, phoneId } = req.body;

  if (!to || !text || !token || !phoneId) {
    return res.status(400).json({ error: 'Paramètres manquants: to, text, token, phoneId' });
  }

  try {
    const response = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to.replace(/\s/g, '').replace('+', ''),
        type: 'text',
        text: { body: text }
      })
    });

    const data = await response.json();

    if (data.error) {
      return res.status(400).json({ success: false, error: data.error.message, data });
    }

    return res.status(200).json({ success: true, data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
