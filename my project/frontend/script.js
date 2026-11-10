const MODELS = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/';
let token = localStorage.getItem('t'), me = null, modelsReady = false, enrollId = null;
const $ = id => document.getElementById(id);

async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Error');
  return d;
}
const tryDo = async fn => { try { await fn(); } catch (e) { alert(e.message); } };

// ---------- Login ----------
function loginView() {
  $('app').innerHTML = `<div class="card"><h2>College Attendance Login</h2>
    <input id="u" placeholder="Username"><br><input id="p" type="password" placeholder="Password"><br>
    <button onclick="login()">Login</button></div>`;
}
const login = () => tryDo(async () => {
  const d = await api('/login', 'POST', { username: $('u').value, password: $('p').value });
  token = d.token; localStorage.setItem('t', token); start();
});
function logout() { localStorage.removeItem('t'); token = null; location.reload(); }

async function start() {
  if (!token) return loginView();
  try { me = await api('/me'); } catch { return loginView(); }
  $('app').innerHTML = `<header><h2>Welcome, ${me.name} (${me.role})</h2><button class="red" onclick="logout()">Logout</button></header><div id="main"></div>`;
  if (me.role === 'admin') adminView();
  else if (me.role === 'teacher') teacherView();
  else studentView();
}

// ---------- Camera / face ----------
async function startCam() {
  if (!modelsReady) {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODELS),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODELS),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODELS)
    ]);
    modelsReady = true;
  }
  $('vid').srcObject = await navigator.mediaDevices.getUserMedia({ video: true });
}
async function getFace() {
  const d = await faceapi.detectSingleFace($('vid'), new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptor();
  if (!d) throw new Error('No face found. Look at the camera and try again.');
  return Array.from(d.descriptor);
}

// ---------- Scanner (admin + teacher) ----------
function scannerHTML(subjects) {
  return `<div class="card"><h3>Take Attendance (Face Scan)</h3>
    <select id="subj">${subjects.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}</select>
    <button onclick="tryDo(startCam)">Start Camera</button><br>
    <video id="vid" autoplay muted playsinline></video><br>
    <button onclick="scan()">Scan Face & Mark Present</button>
    <p id="scanres"></p></div>`;
}
const scan = () => tryDo(async () => {
  const descriptor = await getFace();
  try {
    const r = await api('/attendance/scan', 'POST', { subject_id: +$('subj').value, descriptor });
    $('scanres').innerHTML = `<span class="good">${r.name} ${r.already ? 'was already marked today' : 'marked present'}</span>`;
  } catch (e) { $('scanres').innerHTML = `<span class="bad">${e.message}</span>`; }
});

// ---------- Teacher ----------
async function teacherView() {
  $('main').innerHTML = scannerHTML(await api('/subjects'));
}

// ---------- Student ----------
async function studentView() {
  const rows = await api('/my-attendance');
  $('main').innerHTML = `<div class="card"><h3>My Attendance</h3><table>
    <tr><th>Subject</th><th>Present</th><th>Total classes</th><th>Percentage</th></tr>
    ${rows.map(r => `<tr><td>${r.subject}</td><td>${r.present}</td><td>${r.total}</td>
      <td class="${r.percent < 75 ? 'bad' : 'good'}">${r.percent}%</td></tr>`).join('')}
    </table><p>Below 75% is shown in red.</p></div>`;
}

// ---------- Admin ----------
async function adminView() {
  const [users, subjects] = await Promise.all([api('/users'), api('/subjects')]);
  $('main').innerHTML = `
  <div class="card"><h3>Add User</h3>
    <input id="n" placeholder="Full name"><input id="un" placeholder="Username"><input id="pw" placeholder="Password">
    <select id="rl"><option>student</option><option>teacher</option><option>admin</option></select>
    <button onclick="addUser()">Add</button></div>

  <div class="card"><h3>Users & Access</h3><table>
    <tr><th>Name</th><th>Username</th><th>Role</th><th>Face</th><th></th></tr>
    ${users.map(u => `<tr><td>${u.name}</td><td>${u.username}</td>
      <td><select onchange="setRole(${u.id},this.value)">
        ${['student', 'teacher', 'admin'].map(r => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
      <td>${u.hasFace ? '✅' : '❌'} ${u.role === 'student' ? `<button onclick="pickEnroll(${u.id},'${u.name}')">Enroll face</button>` : ''}</td>
      <td><button class="red" onclick="delUser(${u.id})">Delete</button></td></tr>`).join('')}
  </table></div>

  <div class="card"><h3>Subjects</h3>
    <input id="sn" placeholder="Subject name"><button onclick="addSubject()">Add subject</button>
    <p>${subjects.map(s => s.name).join(', ') || 'No subjects yet'}</p></div>

  <div class="card"><h3>Enroll Student Face</h3>
    <p id="enrollinfo">Click "Enroll face" next to a student above, start the camera in the box below, then press Capture.</p>
    <button onclick="captureFace()">Capture & Save Face</button></div>

  ${scannerHTML(subjects)}`;
}
function pickEnroll(id, name) { enrollId = id; $('enrollinfo').textContent = 'Enrolling: ' + name + ' — start the camera below, then press Capture.'; }
const captureFace = () => tryDo(async () => {
  if (!enrollId) throw new Error('Pick a student first');
  if (!$('vid').srcObject) throw new Error('Start the camera first');
  const descriptor = await getFace();
  await api('/users/' + enrollId + '/face', 'POST', { descriptor });
  alert('Face saved'); enrollId = null; adminView();
});
const addUser = () => tryDo(async () => {
  await api('/users', 'POST', { name: $('n').value, username: $('un').value, password: $('pw').value, role: $('rl').value });
  adminView();
});
const setRole = (id, role) => tryDo(async () => { await api(`/users/${id}/role`, 'PUT', { role }); adminView(); });
const delUser = id => confirm('Delete this user?') && tryDo(async () => { await api('/users/' + id, 'DELETE'); adminView(); });
const addSubject = () => tryDo(async () => { await api('/subjects', 'POST', { name: $('sn').value }); adminView(); });

start();