function normalizeWeeshopSyncUrl(value, fallback) {
  const raw = String(value || '').trim() || fallback;
  return raw.replace(/\/api\/paygate\//i, '/api/yas/');
}

module.exports = { normalizeWeeshopSyncUrl };
