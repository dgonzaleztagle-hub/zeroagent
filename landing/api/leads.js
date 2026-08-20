const crypto = require('crypto');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const name = String(req.body?.name || '').trim();
  const business = String(req.body?.business || '').trim();
  const contact = String(req.body?.contact || '').trim();
  if (!name || !business || !contact) { res.status(400).json({ error: 'Faltan datos.' }); return; }

  const url = String(process.env.STUDIO_SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.STUDIO_SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) { res.status(500).json({ error: 'Formulario no disponible por el momento.' }); return; }

  try {
    const response = await fetch(`${url}/rest/v1/commercial_leads`, {
      method: 'POST',
      headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', prefer: 'return=minimal' },
      body: JSON.stringify({
        id: crypto.randomUUID(), name, business, contact,
        source: 'landing_standalone', created_at: new Date().toISOString()
      })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      res.status(502).json({ error: `No se pudo guardar el contacto: ${detail}` });
      return;
    }
    res.status(201).json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
