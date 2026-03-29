// --- Config ---
const TMDB_API_KEY  = 'c76fd3048678793f73ce4ec7bc973763';
const TMDB_BASE     = 'https://api.themoviedb.org/3';
const TMDB_IMG      = 'https://image.tmdb.org/t/p/w200';
const POLL_INTERVAL = 30_000;

// --- State ---
let currentUser    = null;
let nights         = [];
let movieList      = [];
let presence       = {};
let currentView    = 'active';
let selectedMovies = [];
let pendingNightId = null;
let lastSaveAt     = 0;
const SAVE_COOLDOWN    = 8_000;
const PRESENCE_TIMEOUT = 2 * 60 * 1000; // 2 minutes

// --- DOM refs ---
const sessionName        = document.getElementById('session-name');
const changeNameBtn      = document.getElementById('change-name-btn');
const syncStatus         = document.getElementById('sync-status');
const movieSearchInput   = document.getElementById('movie-search');
const searchBtn          = document.getElementById('search-btn');
const searchResults      = document.getElementById('search-results');
const nightsList         = document.getElementById('nights-list');
const archiveList        = document.getElementById('archive-list');
const newNightBtn        = document.getElementById('new-night-btn');
const addingToBanner     = document.getElementById('adding-to-banner');
const addingToName       = document.getElementById('adding-to-name');
const addingToClear      = document.getElementById('adding-to-clear');
const nameModal          = document.getElementById('name-modal');
const nameForm           = document.getElementById('name-form');
const nameInput          = document.getElementById('name-input');
const addModal           = document.getElementById('add-modal');
const addForm            = document.getElementById('add-form');
const addModalTitle      = document.getElementById('add-modal-title');
const reasonInput        = document.getElementById('reason-input');
const nightAssignSelect  = document.getElementById('night-assign-select');
const addCancel          = document.getElementById('add-cancel');
const nightModal         = document.getElementById('night-modal');
const nightForm          = document.getElementById('night-form');
const nightNameInput     = document.getElementById('night-name-input');
const nightDescInput     = document.getElementById('night-desc-input');
const nightCancel        = document.getElementById('night-cancel');

// --- HTML escaping ---
// Prevents XSS when inserting user-provided or API-sourced strings into innerHTML.
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

// --- Confirm dialog ---
// Returns a Promise<boolean> so callers can `await confirmDialog(...)`.
// Uses the native <dialog> element which cannot be blocked by the browser.
const confirmModal   = document.getElementById('confirm-modal');
const confirmMessage = document.getElementById('confirm-message');
const confirmOk      = document.getElementById('confirm-ok');
const confirmCancel  = document.getElementById('confirm-cancel');

function confirmDialog(message) {
  confirmMessage.textContent = message;
  confirmModal.showModal();
  return new Promise((resolve) => {
    const finish = (result) => {
      confirmModal.close();
      confirmOk.removeEventListener('click', onOk);
      confirmCancel.removeEventListener('click', onCancel);
      confirmModal.removeEventListener('cancel', onEscape);
      resolve(result);
    };
    const onOk     = () => finish(true);
    const onCancel = () => finish(false);
    const onEscape = () => finish(false); // fired when user presses Escape
    confirmOk.addEventListener('click', onOk);
    confirmCancel.addEventListener('click', onCancel);
    confirmModal.addEventListener('cancel', onEscape);
  });
}

// --- Init ---
async function init() {
  const savedName = localStorage.getItem('movienight-name');
  if (savedName) setUser(savedName);
  else nameModal.showModal();
  await refresh();
  // Start presence after data is loaded so we don't overwrite with empty state
  if (currentUser) presenceHeartbeat();
  setInterval(refresh, POLL_INTERVAL);
  setInterval(presenceHeartbeat, POLL_INTERVAL);
}

function setUser(name) {
  currentUser = { name };
  sessionName.textContent = name;
  localStorage.setItem('movienight-name', name);
}

async function refresh() {
  if (Date.now() - lastSaveAt < SAVE_COOLDOWN) return;
  try {
    const data = await loadData();
    nights    = data.nights   || [];
    movieList = data.movies   || [];
    presence  = data.presence || {};
    renderAll();
    renderPresence();
  } catch {
    setSyncStatus('Could not load list', true);
  }
}

async function persist() {
  setSyncStatus('Saving…');
  try {
    await saveData({ nights, movies: movieList, presence });
    lastSaveAt = Date.now();
    setSyncStatus('Saved');
  } catch {
    setSyncStatus('Save failed — check your connection', true);
  }
}

async function presenceHeartbeat() {
  if (!currentUser) return;
  const now    = Date.now();
  const cutoff = now - PRESENCE_TIMEOUT;
  presence[currentUser.name] = now;
  // Prune stale entries
  Object.keys(presence).forEach(k => { if (presence[k] < cutoff) delete presence[k]; });
  renderPresence();
  try {
    await saveData({ nights, movies: movieList, presence });
  } catch { /* presence is best-effort, fail silently */ }
}

function setSyncStatus(msg, isError = false) {
  syncStatus.textContent = msg;
  syncStatus.className = 'sync-status' + (isError ? ' sync-error' : '');
  if (!isError) setTimeout(() => { syncStatus.textContent = ''; }, 2500);
}

// --- Tabs ---
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentView = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('view-active').hidden  = currentView !== 'active';
    document.getElementById('view-archive').hidden = currentView !== 'archive';
    renderAll();
  });
});

// --- Name modal ---
nameForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;
  setUser(name);
  nameModal.close();
  renderAll();
  presenceHeartbeat();
});

changeNameBtn.addEventListener('click', () => {
  nameInput.value = currentUser?.name || '';
  nameModal.showModal();
});

// --- "Adding to" banner ---
function setPendingNight(nightId) {
  pendingNightId = nightId;
  if (nightId) {
    const night = nights.find(n => n.id === nightId);
    addingToName.textContent = night?.name || '';
    addingToBanner.hidden = false;
  } else {
    addingToBanner.hidden = true;
  }
}

addingToClear.addEventListener('click', () => setPendingNight(null));

// --- New movie night ---
newNightBtn.addEventListener('click', () => {
  nightNameInput.value = '';
  nightDescInput.value = '';
  nightModal.showModal();
});

nightCancel.addEventListener('click', () => nightModal.close());

nightForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = nightNameInput.value.trim();
  if (!name) return;
  nights.push({
    id:          `night-${Date.now()}`,
    name,
    description: nightDescInput.value.trim() || null,
    status:      'idea',
    date:        null,
    createdBy:   currentUser?.name || '?',
    createdAt:   Date.now(),
  });
  nightModal.close();
  renderAll();
  await persist();
});

// --- TMDB search ---
searchBtn.addEventListener('click', searchMovies);
movieSearchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') searchMovies(); });

async function searchMovies() {
  const query = movieSearchInput.value.trim();
  if (!query) return;
  selectedMovies = [];
  searchResults.innerHTML = '<li class="result-status">Searching…</li>';
  try {
    const res  = await fetch(
      `${TMDB_BASE}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&language=en-US&page=1`
    );
    const data = await res.json();
    renderSearchResults(data.results.slice(0, 6));
  } catch {
    searchResults.innerHTML = '<li class="result-status">Something went wrong.</li>';
  }
}

function renderSearchResults(results) {
  searchResults.innerHTML = '';
  if (!results.length) {
    searchResults.innerHTML = '<li class="result-status">No results found.</li>';
    return;
  }
  results.forEach(movie => {
    const year         = movie.release_date ? movie.release_date.slice(0, 4) : '—';
    const alreadyAdded = movieList.some(m => m.tmdbId === movie.id);
    const li = document.createElement('li');
    if (alreadyAdded) li.classList.add('result-already-added');
    li.innerHTML = `
      ${movie.poster_path
        ? `<img src="${TMDB_IMG}${movie.poster_path}" alt="${esc(movie.title)} poster" />`
        : '<div class="result-poster-placeholder"></div>'}
      <div class="result-info">
        <strong>${esc(movie.title)}</strong>
        <span>${esc(year)}${alreadyAdded ? ' · already on list' : ''}</span>
      </div>
      <div class="result-check" aria-hidden="true"></div>
    `;
    if (!alreadyAdded) li.addEventListener('click', () => toggleMovieSelection(movie, li));
    searchResults.appendChild(li);
  });
  const actionLi = document.createElement('li');
  actionLi.className = 'result-action';
  actionLi.id = 'add-selected-row';
  actionLi.style.display = 'none';
  actionLi.innerHTML = `<button type="button" id="add-selected-btn">Add selected</button>`;
  actionLi.querySelector('button').addEventListener('click', openAddModal);
  searchResults.appendChild(actionLi);
}

function toggleMovieSelection(movie, li) {
  const idx = selectedMovies.findIndex(m => m.id === movie.id);
  if (idx === -1) { selectedMovies.push(movie); li.classList.add('selected'); }
  else            { selectedMovies.splice(idx, 1); li.classList.remove('selected'); }
  updateAddSelectedBtn();
}

function updateAddSelectedBtn() {
  const row = document.getElementById('add-selected-row');
  const btn = document.getElementById('add-selected-btn');
  if (!row || !btn) return;
  const n = selectedMovies.length;
  row.style.display = n > 0 ? '' : 'none';
  btn.textContent = n === 1 ? 'Add 1 movie' : `Add ${n} movies`;
}

// --- Add modal ---
function openAddModal() {
  if (!selectedMovies.length) return;
  if (selectedMovies.length === 1) {
    addModalTitle.textContent = selectedMovies[0].title;
  } else {
    addModalTitle.innerHTML = selectedMovies
      .map(m => `<span class="modal-movie-item">${esc(m.title)}</span>`).join('');
  }
  reasonInput.value = '';
  // Populate night dropdown
  const activeNights = nights.filter(n => n.status !== 'completed');
  nightAssignSelect.innerHTML = '<option value="">— Ungrouped —</option>';
  activeNights.forEach(n => {
    const opt = document.createElement('option');
    opt.value = n.id;
    opt.textContent = n.name;
    if (n.id === pendingNightId) opt.selected = true;
    nightAssignSelect.appendChild(opt);
  });
  addModal.showModal();
}

addCancel.addEventListener('click', () => { addModal.close(); });

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedMovies.length || !currentUser) return;
  const reason  = reasonInput.value.trim() || null;
  const nightId = nightAssignSelect.value || null;
  const ts = Date.now();
  const newEntries = selectedMovies.map((movie, i) => ({
    id:          `${movie.id}-${ts}-${i}`,
    tmdbId:      movie.id,
    title:       movie.title,
    year:        movie.release_date ? movie.release_date.slice(0, 4) : '—',
    releaseDate: movie.release_date || null,
    poster:      movie.poster_path ? `${TMDB_IMG}${movie.poster_path}` : null,
    reason,
    suggestedBy: currentUser.name,
    nightId,
    addedAt:     Date.now(),
    attendees:   { [currentUser.name]: true },
  }));
  movieList = [...movieList, ...newEntries];
  selectedMovies = [];
  searchResults.innerHTML = '';
  movieSearchInput.value = '';
  setPendingNight(null);
  addModal.close();
  renderAll();
  await persist();
});

// --- Night actions ---
async function updateNightStatus(nightId, newStatus) {
  const night = nights.find(n => n.id === nightId);
  if (!night) return;
  night.status = newStatus;
  if (newStatus !== 'planned') night.date = null;
  renderAll();
  await persist();
}

async function updateNightDate(nightId, date) {
  const night = nights.find(n => n.id === nightId);
  if (!night) return;
  night.date = date || null;
  await persist();
}

async function removeNight(nightId) {
  const night = nights.find(n => n.id === nightId);
  if (!night) return;
  if (!await confirmDialog(`Remove "${night.name}"? Its movies will be moved to Ungrouped.`)) return;
  nights = nights.filter(n => n.id !== nightId);
  movieList.forEach(m => { if (m.nightId === nightId) m.nightId = null; });
  renderAll();
  await persist();
}

async function reopenNight(nightId) {
  const night = nights.find(n => n.id === nightId);
  if (!night) return;
  night.status = 'idea';
  renderAll();
  await persist();
}

// --- Move movie ---
async function removeMovie(tmdbId) {
  const movie = movieList.find(m => m.tmdbId === tmdbId);
  if (!movie) return;
  if (!await confirmDialog(`Remove "${movie.title}" from the list?`)) return;
  movieList = movieList.filter(m => m.tmdbId !== tmdbId);
  renderAll();
  await persist();
}

async function moveMovie(tmdbId, newNightId) {
  const movie = movieList.find(m => m.tmdbId === tmdbId);
  if (!movie) return;
  movie.nightId = newNightId || null;
  renderAll();
  await persist();
}

// --- Edit reason (inline) ---
function startEditReason(tmdbId, currentReason) {
  const card = document.querySelector(`[data-tmdb-id="${tmdbId}"]`);
  if (!card) return;
  const wrap = card.querySelector('.movie-reason-wrap');
  if (!wrap) return;

  const input  = document.createElement('input');
  input.type   = 'text';
  input.value  = currentReason || '';
  input.maxLength = 120;
  input.placeholder = 'e.g. Sarah has never seen it';
  input.className = 'reason-edit-input';

  const save   = document.createElement('button');
  save.type    = 'button';
  save.textContent = 'Save';
  save.className = 'reason-edit-save';

  const cancel = document.createElement('button');
  cancel.type  = 'button';
  cancel.textContent = '✕';
  cancel.className = 'reason-edit-cancel';

  const row = document.createElement('div');
  row.className = 'reason-edit-row';
  row.append(input, save, cancel);
  wrap.innerHTML = '';
  wrap.appendChild(row);
  input.focus();

  const commit = async () => {
    const movie = movieList.find(m => m.tmdbId === tmdbId);
    if (movie) {
      movie.reason = input.value.trim() || null;
      renderAll();
      await persist();
    }
  };
  save.addEventListener('click', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  commit();
    if (e.key === 'Escape') renderAll();
  });
  cancel.addEventListener('click', () => renderAll());
}

// --- Attendance ---
async function toggleAttendance(tmdbId) {
  if (!currentUser) return;
  const movie = movieList.find(m => m.tmdbId === tmdbId);
  if (!movie) return;
  if (movie.attendees[currentUser.name]) delete movie.attendees[currentUser.name];
  else movie.attendees[currentUser.name] = true;
  renderAll();
  await persist();
}

// --- Presence ---
function renderPresence() {
  const wrap = document.getElementById('presence-wrap');
  const list = document.getElementById('presence-list');
  if (!wrap || !list) return;

  const cutoff = Date.now() - PRESENCE_TIMEOUT;
  const active = Object.entries(presence)
    .filter(([, ts]) => ts > cutoff)
    .map(([name]) => name)
    .sort();

  if (!active.length) { wrap.hidden = true; return; }

  wrap.hidden = false;
  list.innerHTML = active
    .map(name => `<span class="presence-chip${name === currentUser?.name ? ' presence-self' : ''}">${esc(name)}</span>`)
    .join('');
}

// --- Render ---
function renderAll() {
  if (currentView === 'active') renderActiveView();
  else renderArchiveView();
}

function renderActiveView() {
  nightsList.innerHTML = '';
  const activeNights = nights.filter(n => n.status !== 'completed');

  activeNights.forEach(night => {
    const movies = movieList
      .filter(m => m.nightId === night.id)
      .sort((a, b) => {
        if (!a.releaseDate) return 1;
        if (!b.releaseDate) return -1;
        return new Date(a.releaseDate) - new Date(b.releaseDate);
      });
    nightsList.appendChild(buildNightCard(night, movies));
  });

  // Ungrouped
  const ungrouped = movieList.filter(m => !m.nightId);
  if (ungrouped.length) {
    const section = document.createElement('div');
    section.className = 'night-card ungrouped-section';
    const label = document.createElement('h3');
    label.className = 'ungrouped-label';
    label.textContent = 'Ungrouped';
    section.appendChild(label);
    const ul = document.createElement('ul');
    ul.className = 'night-movies';
    ungrouped.forEach(m => ul.appendChild(buildMovieCard(m)));
    section.appendChild(ul);
    nightsList.appendChild(section);
  }
}

function buildNightCard(night, movies) {
  const card = document.createElement('div');
  card.className = 'night-card';
  card.dataset.nightId = night.id;

  // Header: name + status select
  const header = document.createElement('div');
  header.className = 'night-header';

  const nameEl = document.createElement('h3');
  nameEl.className = 'night-name';
  nameEl.textContent = night.name;

  const statusSel = document.createElement('select');
  statusSel.className = `status-select status-${night.status}`;
  [
    { value: 'idea',      label: 'Coming Soon'  },
    { value: 'planned',   label: 'Now Showing'  },
    { value: 'completed', label: 'Screened ✓'   },
  ].forEach(({ value, label }) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (value === night.status) opt.selected = true;
    statusSel.appendChild(opt);
  });
  statusSel.addEventListener('change', () => updateNightStatus(night.id, statusSel.value));

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn-remove-night';
  removeBtn.title = 'Remove movie night';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', () => removeNight(night.id));

  header.append(nameEl, statusSel, removeBtn);
  card.appendChild(header);

  // Optional date row (only when planned)
  if (night.status === 'planned') {
    const dateRow = document.createElement('div');
    dateRow.className = 'night-date-row';
    const lbl = document.createElement('span');
    lbl.className = 'night-date-label';
    lbl.textContent = 'Date';
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'night-date-input';
    dateInput.value = night.date || '';
    dateInput.addEventListener('change', () => updateNightDate(night.id, dateInput.value));
    dateRow.append(lbl, dateInput);
    card.appendChild(dateRow);
  }

  // Description
  if (night.description) {
    const desc = document.createElement('p');
    desc.className = 'night-description';
    desc.textContent = night.description;
    card.appendChild(desc);
  }

  // Movie list
  if (movies.length) {
    const ul = document.createElement('ul');
    ul.className = 'night-movies';
    movies.forEach(m => ul.appendChild(buildMovieCard(m)));
    card.appendChild(ul);
  } else {
    const empty = document.createElement('p');
    empty.className = 'night-empty';
    empty.textContent = 'No movies yet.';
    card.appendChild(empty);
  }

  // Footer
  const footer = document.createElement('div');
  footer.className = 'night-footer';
  const addBtn = document.createElement('button');
  addBtn.className = 'btn-add-to-night';
  addBtn.textContent = '+ Add movie';
  addBtn.addEventListener('click', () => {
    setPendingNight(night.id);
    movieSearchInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    movieSearchInput.focus();
  });
  footer.appendChild(addBtn);
  card.appendChild(footer);

  return card;
}

function buildMovieCard(movie) {
  const isAttending   = currentUser && !!movie.attendees[currentUser.name];
  const attendeeNames = Object.keys(movie.attendees);
  const attendeeCount = attendeeNames.length;

  const otherNights = nights.filter(n => n.status !== 'completed' && n.id !== movie.nightId);
  const hasAssigned  = !!movie.nightId;
  const canAssign    = otherNights.length > 0 || hasAssigned;

  const li = document.createElement('li');
  li.className = 'movie-card';
  li.dataset.tmdbId = movie.tmdbId;

  li.innerHTML = `
    ${movie.poster
      ? `<img src="${movie.poster}" alt="${esc(movie.title)} poster" />`
      : '<div class="poster-placeholder"></div>'}
    <div class="movie-card-info">
      <h3>${esc(movie.title)} <span class="movie-year">${esc(movie.year)}</span></h3>
      <p class="movie-meta">Suggested by ${esc(movie.suggestedBy)}</p>
      <div class="movie-reason-wrap">
        ${movie.reason
          ? `<p class="movie-reason">"${esc(movie.reason)}" <button class="btn-edit-reason" title="Edit reason">✎</button></p>`
          : `<button class="btn-add-reason">+ Add reason</button>`}
      </div>
      <div class="movie-edit-wrap">
        <button class="btn-toggle-edit" type="button">Edit ▾</button>
        <div class="movie-edit-panel" hidden>
          ${canAssign ? `<button class="btn-assign-night" type="button">${hasAssigned ? 'Move' : 'Add to viewing'}</button>` : ''}
          <button class="btn-remove-movie-inline" type="button">Remove</button>
        </div>
        ${canAssign ? '<div class="night-picker" hidden></div>' : ''}
      </div>
    </div>
    <div class="movie-card-stub">
      <div class="stub-attendance">
        <button class="btn-attendee-count" type="button" title="Show who's in">
          <span class="count-num">${attendeeCount}</span>
          <span class="count-label">${attendeeCount === 1 ? 'person' : 'people'}</span>
        </button>
        <div class="stub-names" hidden>
          ${attendeeNames.length
            ? attendeeNames.map(n => `<span class="stub-name${n === currentUser?.name ? ' is-self' : ''}">${esc(n)}</span>`).join('')
            : '<span class="stub-name" style="font-style:italic">—</span>'}
        </div>
      </div>
      <button class="btn-im-in ${isAttending ? 'active' : ''}" type="button">
        ${isAttending ? '✓ In' : 'I\'m in'}
      </button>
    </div>
  `;

  // I'm in
  li.querySelector('.btn-im-in').addEventListener('click', () => toggleAttendance(movie.tmdbId));

  // Reason editing
  li.querySelector('.btn-edit-reason')
    ?.addEventListener('click', () => startEditReason(movie.tmdbId, movie.reason));
  li.querySelector('.btn-add-reason')
    ?.addEventListener('click', () => startEditReason(movie.tmdbId, null));

  // Attendee names toggle
  li.querySelector('.btn-attendee-count').addEventListener('click', () => {
    const names = li.querySelector('.stub-names');
    names.hidden = !names.hidden;
  });

  // Edit panel toggle
  const editToggle  = li.querySelector('.btn-toggle-edit');
  const editPanel   = li.querySelector('.movie-edit-panel');
  const nightPicker = li.querySelector('.night-picker');

  editToggle.addEventListener('click', () => {
    const opening = editPanel.hidden;
    editPanel.hidden = !opening;
    if (nightPicker) nightPicker.hidden = true;
    editToggle.classList.toggle('open', opening);
    editToggle.textContent = opening ? 'Edit ▴' : 'Edit ▾';
  });

  // Night assignment
  const assignBtn = li.querySelector('.btn-assign-night');
  if (assignBtn && nightPicker) {
    const options = [
      ...(hasAssigned ? [{ id: '__none__', name: '— Ungrouped —' }] : []),
      ...otherNights.map(n => ({ id: n.id, name: n.name })),
    ];
    if (options.length === 1) {
      // Only one destination — assign immediately on click
      assignBtn.addEventListener('click', () =>
        moveMovie(movie.tmdbId, options[0].id === '__none__' ? null : options[0].id)
      );
    } else {
      // Multiple options — show picker chips
      nightPicker.innerHTML = options
        .map(o => `<button class="night-pick-btn" type="button" data-night-id="${o.id}">${esc(o.name)}</button>`)
        .join('');
      assignBtn.addEventListener('click', () => { nightPicker.hidden = !nightPicker.hidden; });
      nightPicker.querySelectorAll('.night-pick-btn').forEach(btn =>
        btn.addEventListener('click', () =>
          moveMovie(movie.tmdbId, btn.dataset.nightId === '__none__' ? null : btn.dataset.nightId)
        )
      );
    }
  }

  // Remove
  li.querySelector('.btn-remove-movie-inline').addEventListener('click', () => removeMovie(movie.tmdbId));

  return li;
}

function renderArchiveView() {
  archiveList.innerHTML = '';
  const completed = nights.filter(n => n.status === 'completed');

  if (!completed.length) {
    archiveList.innerHTML = '<p class="empty-state">No completed movie nights yet.</p>';
    return;
  }

  completed.forEach(night => {
    const movies = movieList.filter(m => m.nightId === night.id);

    const details = document.createElement('details');
    details.className = 'archive-night';

    const summary = document.createElement('summary');
    summary.className = 'archive-summary';
    summary.innerHTML = `
      <span class="archive-night-name">${esc(night.name)}</span>
      <span class="archive-night-meta">
        ${night.date ? esc(formatDate(night.date)) + ' · ' : ''}
        ${movies.length} ${movies.length === 1 ? 'movie' : 'movies'}
      </span>
    `;
    details.appendChild(summary);

    if (night.description) {
      const desc = document.createElement('p');
      desc.className = 'night-description';
      desc.textContent = night.description;
      details.appendChild(desc);
    }

    if (movies.length) {
      const ul = document.createElement('ul');
      ul.className = 'night-movies archive-movies';
      movies.forEach(m => {
        // Simplified read-only card for archive
        const li = document.createElement('li');
        li.className = 'movie-card';
        const attendeeNames = Object.keys(m.attendees);
        li.innerHTML = `
          ${m.poster ? `<img src="${m.poster}" alt="${esc(m.title)} poster" />` : '<div class="poster-placeholder"></div>'}
          <div class="movie-card-info">
            <h3>${esc(m.title)} <span class="movie-year">${esc(m.year)}</span></h3>
            <p class="movie-meta">Suggested by ${esc(m.suggestedBy)}</p>
            ${m.reason ? `<p class="movie-reason">"${esc(m.reason)}"</p>` : ''}
            <p class="movie-meta">${esc(attendeeNames.join(', ')) || 'No attendees recorded'}</p>
          </div>
        `;
        ul.appendChild(li);
      });
      details.appendChild(ul);
    }

    const footer = document.createElement('div');
    footer.className = 'archive-footer';
    const reopenBtn = document.createElement('button');
    reopenBtn.className = 'btn-reopen';
    reopenBtn.textContent = 'Reopen';
    reopenBtn.addEventListener('click', () => reopenNight(night.id));
    footer.appendChild(reopenBtn);
    details.appendChild(footer);

    archiveList.appendChild(details);
  });
}

function formatDate(dateStr) {
  // Append time to prevent UTC midnight being interpreted as the previous day
  // in negative-offset timezones (e.g. UTC-5 would show 27/03 for 2026-03-28)
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric'
  });
}

init();
