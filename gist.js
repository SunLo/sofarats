const GIST_ID    = 'cd6804644780de651061cfd528b0fc59';
const GIST_TOKEN = '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';
const GIST_FILE  = 'movies.json';

async function loadData() {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: { 'Accept': 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`Gist read failed: ${res.status}`);
  const gist = await res.json();
  const raw  = JSON.parse(gist.files[GIST_FILE].content);
  // Migrate from old format (plain movies array)
  if (Array.isArray(raw)) return { nights: [], movies: raw };
  return raw;
}

async function saveData(data) {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${GIST_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: { [GIST_FILE]: { content: JSON.stringify(data, null, 2) } }
    }),
  });
  if (!res.ok) throw new Error(`Gist write failed: ${res.status}`);
}
