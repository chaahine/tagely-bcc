import nodemailer from 'nodemailer';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { to, subject, html } = req.body;
  if (!to || !subject || !html) {
    return res.status(400).json({ error: 'Paramètres manquants: to, subject, html' });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: 'chahinedjadel@gmail.com',
        pass: 'odobkuckrwrrlryu'
      }
    });

    await transporter.sendMail({
      from: '"BCC Stagely" <chahinedjadel@gmail.com>',
      to,
      subject,
      html
    });

    return res.status(200).json({ success: true });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
