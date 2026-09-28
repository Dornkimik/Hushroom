let groupRooms = [], groupState = null, groupPanel = null, groupRefresh = 0;
function renderGroups() {
  $('#groups').replaceChildren(...groupRooms.map(group => {
    const button = element('button', `nav-room group-room${current?.group === group.id ? ' active' : ''}`);
    button.append(element('span', 'hash', group.access === 'invite' ? '◇' : '#'), element('span', 'name', group.name), element('small', 'count', group.invited ? 'Invited' : group.joined ? 'Joined' : `${group.count}/20`));
    button.disabled = group.blocked;
    button.title = group.blocked ? 'You were removed from this room' : group.description;
    button.onclick = () => group.joined ? select({ group: group.id }) : openGroup(group);
    return button;
  }));
  $('#groups-empty').hidden = groupRooms.length > 0;
}
async function refreshGroups() {
  const request = ++groupRefresh;
  try {
    const list = await api('groups'); if (request !== groupRefresh) return;
    groupRooms = list; renderGroups();
    if (current?.group && !list.some(g => g.id === current.group && g.joined)) closeCurrentGroup('This room is no longer available to you.');
    if (groupPanel && !list.some(g => g.id === groupPanel.id && !g.blocked)) { $('#group-dialog').close(); groupPanel = null; }
  } catch(e) { error(e.message); }
}
function closeCurrentGroup(reason) {
  const id = current?.group;
  if (id) { groupState = null; select(rooms[0] ? { room: rooms[0].id } : null); drafts.delete(`group:${id}`); error(reason); }
}
function groupStateChanged(state) {
  const index = groupRooms.findIndex(g => g.id === state.id);
  if (index !== -1) groupRooms[index] = { ...groupRooms[index], ...state };
  if (current?.group === state.id) { groupState = state; updateHeading(); renderMessages(); }
  if (groupPanel?.id === state.id) { groupPanel = state; renderGroupMembers(); groupPermissions(); }
  renderGroups();
}
async function openGroup(group = null) {
  $('#group-error').textContent = '';
  try {
    groupPanel = group?.joined ? await api(`groups/state?group=${encodeURIComponent(group.id)}`) : group;
    $('#group-form').reset();
    $('#group-name').value = groupPanel?.name || '';
    $('#group-description').value = groupPanel?.description || '';
    $('#group-rules').value = groupPanel?.rules || '';
    $('#group-access').value = groupPanel?.access || 'open';
    $('#group-dialog-title').textContent = groupPanel ? 'Room details & members' : 'Create a temporary room';
    groupPermissions(); renderGroupMembers(); $('#group-dialog').showModal();
  } catch(e) { error(e.message); }
}
function groupPermissions() {
  const owner = groupPanel?.owner === me.id, creating = !groupPanel;
  for (const id of ['group-name', 'group-description', 'group-rules']) $(`#${id}`).readOnly = !creating && !owner;
  $('#group-access').disabled = !creating && !owner;
  $('#group-save').hidden = !creating && !owner;
  $('#group-save').textContent = creating ? 'Create room' : 'Save changes';
  $('#group-join').hidden = creating || groupPanel.joined;
  $('#group-join').disabled = Boolean(groupPanel?.blocked) || !encryptionClient;
  $('#group-leave').hidden = !groupPanel?.joined;
  $('#group-leave').disabled = owner && groupPanel.count > 1;
  $('#group-delete').hidden = !owner;
  $('#group-owner-note').hidden = !owner || groupPanel.count < 2;
  $('#group-invite-form').hidden = !owner;
  $('#group-member-section').hidden = !groupPanel?.joined;
  const candidates = people.filter(p => !groupPanel?.members?.some(m => m.id === p.id));
  $('#group-invite-person').replaceChildren(...candidates.map(p => {
    const option = element('option', '', p.alias); option.value = p.id; return option;
  }));
  $('#group-invite-submit').disabled = !candidates.length;
}
function renderGroupMembers() {
  const owner = groupPanel?.owner === me.id;
  $('#group-members').replaceChildren(...(groupPanel?.members || []).map(person => {
    const row = element('div', 'group-member'), info = element('div', 'group-member-info');
    info.append(username(person.alias, '', person.displayAsAdmin));
    info.append(element('small', '', `${person.id === groupPanel.owner ? 'Owner · ' : ''}${person.online ? 'Online' : 'Offline'}${owner ? ` · ${person.messages} ${person.messages === 1 ? 'message' : 'messages'} sent` : ''}`));
    row.append(info);
    if (person.id !== me.id) {
      const actions = element('div', 'group-member-actions');
      const verify = element('button', 'text-button', 'Verify identity');
      verify.type = 'button'; verify.onclick = () => showVerification(person.id); actions.append(verify);
      if (owner) for (const [action, label] of [['transfer', 'Make owner'], ['kick', 'Kick']]) {
        const button = element('button', action === 'kick' ? 'danger-small' : 'text-button', label);
        button.type = 'button'; button.onclick = () => {
          const explanation = action === 'kick' ? `Remove ${person.alias}? They will lose access and cannot rejoin with this session.` : `Make ${person.alias} the owner? You will give up room management controls.`;
          if (confirm(explanation)) groupAction(action, { member: person.id });
        }; actions.append(button);
      }
      row.append(actions);
    }
    return row;
  }));
}
async function groupAction(action, extra = {}) {
  const id = groupPanel?.id; if (!id) return;
  $('#group-error').textContent = '';
  try {
    const result = await api(`groups/${action}`, { group: id, ...extra });
    if (action === 'join') { $('#group-dialog').close(); await refreshGroups(); await select({ group: id }); }
    else if (action === 'delete' || action === 'leave') { $('#group-dialog').close(); await refreshGroups(); }
    else if (result.id) groupStateChanged(result);
    else if (action === 'invite') $('#group-error').textContent = 'Invitation sent. The room now appears in their temporary rooms list.';
  } catch(e) { $('#group-error').textContent = e.message; }
}
function setupGroups() {
  $('#create-group').onclick = () => openGroup();
  $('#group-details').onclick = () => openGroup(groupState);
  $('#group-form').onsubmit = async event => {
    event.preventDefault(); const button = $('#group-save'); button.disabled = true;
    const details = { name: $('#group-name').value, description: $('#group-description').value, rules: $('#group-rules').value, access: $('#group-access').value };
    try {
      if (groupPanel) await groupAction('update', details);
      else {
        const created = await api('groups/create', details);
        $('#group-dialog').close(); await refreshGroups(); await select({ group: created.id });
      }
    } catch(e) { $('#group-error').textContent = e.message; }
    finally { button.disabled = false; }
  };
  $('#group-join').onclick = () => groupAction('join');
  $('#group-leave').onclick = () => groupAction('leave');
  $('#group-delete').onclick = () => { if (confirm('Delete this temporary room and all its messages for everyone?')) groupAction('delete'); };
  $('#group-invite-form').onsubmit = event => { event.preventDefault(); groupAction('invite', { member: $('#group-invite-person').value }); };
}
