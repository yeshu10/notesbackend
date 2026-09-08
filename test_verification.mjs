import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Note from './src/models/Note.js';
import User from './src/models/User.js';

dotenv.config();

const API_BASE = 'http://localhost:5000/api';

async function apiRequest(endpoint, method = 'GET', body = null, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${API_BASE}${endpoint}`, options);
  const data = await res.json();
  return { status: res.status, ok: res.ok, data };
}

async function runTests() {
  console.log('====================================================');
  console.log('🚀 RUNNING END-TO-END TRASH VS ARCHIVE VERIFICATION');
  console.log('====================================================\n');

  // Connect to MongoDB directly to verify DB state
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected to MongoDB Atlas directly for database record verification.');

  // Create test user 1 (Owner)
  const testUserEmail = `test_owner_${Date.now()}@example.com`;
  const testPassword = 'Password123!';
  const regRes = await apiRequest('/auth/register', 'POST', {
    name: 'Test Owner',
    email: testUserEmail,
    password: testPassword
  });

  const token = regRes.data.token;
  const userId = regRes.data.user._id || regRes.data.user.id;
  console.log(`✅ Test user registered: ${testUserEmail} (ID: ${userId})`);

  // Create test user 2 (Collaborator)
  const collabEmail = `test_collab_${Date.now()}@example.com`;
  const regCollab = await apiRequest('/auth/register', 'POST', {
    name: 'Test Collaborator',
    email: collabEmail,
    password: testPassword
  });
  const collabToken = regCollab.data.token;
  console.log(`✅ Collaborator registered: ${collabEmail}`);

  const results = {};

  try {
    // -------------------------------------------------------------
    // TEST 1: Create Note -> Active State
    // -------------------------------------------------------------
    console.log('\n--- Running TEST 1: Create Note (Normal Active Note) ---');
    const noteTitle = `Test Note 1 - ${Date.now()}`;
    const createRes = await apiRequest('/notes', 'POST', {
      title: noteTitle,
      content: 'This is a test active note content #work',
      tags: ['work', 'important']
    }, token);

    const noteId = createRes.data._id;
    console.log(`Created note ID: ${noteId}`);

    // Verify DB
    const dbNote1 = await Note.findById(noteId);
    const passT1_DB = dbNote1.isArchived === false && dbNote1.isTrashed === false;
    console.log(`DB Verification: isArchived=${dbNote1.isArchived}, isTrashed=${dbNote1.isTrashed} -> ${passT1_DB ? 'PASS' : 'FAIL'}`);

    // Verify API filtering
    const myNotesRes = await apiRequest('/notes?filter=mine', 'GET', null, token);
    const inMyNotes = myNotesRes.data.notes.some(n => n._id === noteId);
    const archiveRes1 = await apiRequest('/notes?filter=archived', 'GET', null, token);
    const inArchive1 = archiveRes1.data.notes.some(n => n._id === noteId);
    const trashRes1 = await apiRequest('/notes?filter=trash', 'GET', null, token);
    const inTrash1 = trashRes1.data.notes.some(n => n._id === noteId);

    const passT1 = passT1_DB && inMyNotes && !inArchive1 && !inTrash1;
    results['Test 1: Create Note (Active)'] = passT1 ? 'PASS' : 'FAIL';
    console.log(`Test 1 Result: ${results['Test 1: Create Note (Active)']} (In MyNotes: ${inMyNotes}, In Archive: ${inArchive1}, In Trash: ${inTrash1})`);

    // -------------------------------------------------------------
    // TEST 2: Archive Note -> Archive Section
    // -------------------------------------------------------------
    console.log('\n--- Running TEST 2: Archive Note ---');
    await apiRequest(`/notes/${noteId}/archive`, 'PATCH', {}, token);
    
    // Verify DB
    const dbNote2 = await Note.findById(noteId);
    const passT2_DB = dbNote2.isArchived === true && dbNote2.isTrashed === false && dbNote2.archivedAt instanceof Date;
    console.log(`DB Verification: isArchived=${dbNote2.isArchived}, isTrashed=${dbNote2.isTrashed}, archivedAt=${dbNote2.archivedAt} -> ${passT2_DB ? 'PASS' : 'FAIL'}`);

    // Verify API filtering
    const myNotesRes2 = await apiRequest('/notes?filter=mine', 'GET', null, token);
    const inMyNotes2 = myNotesRes2.data.notes.some(n => n._id === noteId);
    const archiveRes2 = await apiRequest('/notes?filter=archived', 'GET', null, token);
    const inArchive2 = archiveRes2.data.notes.some(n => n._id === noteId);
    const trashRes2 = await apiRequest('/notes?filter=trash', 'GET', null, token);
    const inTrash2 = trashRes2.data.notes.some(n => n._id === noteId);

    const passT2 = passT2_DB && !inMyNotes2 && inArchive2 && !inTrash2;
    results['Test 2: Archive Note'] = passT2 ? 'PASS' : 'FAIL';
    console.log(`Test 2 Result: ${results['Test 2: Archive Note']} (In MyNotes: ${inMyNotes2}, In Archive: ${inArchive2}, In Trash: ${inTrash2})`);

    // -------------------------------------------------------------
    // TEST 3: Unarchive Note -> Active Notes
    // -------------------------------------------------------------
    console.log('\n--- Running TEST 3: Unarchive Note ---');
    await apiRequest(`/notes/${noteId}/unarchive`, 'PATCH', {}, token);

    // Verify DB
    const dbNote3 = await Note.findById(noteId);
    const passT3_DB = dbNote3.isArchived === false && dbNote3.archivedAt === null && dbNote3.isTrashed === false;
    console.log(`DB Verification: isArchived=${dbNote3.isArchived}, archivedAt=${dbNote3.archivedAt}, isTrashed=${dbNote3.isTrashed} -> ${passT3_DB ? 'PASS' : 'FAIL'}`);

    // Verify API filtering
    const myNotesRes3 = await apiRequest('/notes?filter=mine', 'GET', null, token);
    const inMyNotes3 = myNotesRes3.data.notes.some(n => n._id === noteId);
    const archiveRes3 = await apiRequest('/notes?filter=archived', 'GET', null, token);
    const inArchive3 = archiveRes3.data.notes.some(n => n._id === noteId);
    const trashRes3 = await apiRequest('/notes?filter=trash', 'GET', null, token);
    const inTrash3 = trashRes3.data.notes.some(n => n._id === noteId);

    const passT3 = passT3_DB && inMyNotes3 && !inArchive3 && !inTrash3;
    results['Test 3: Unarchive Note'] = passT3 ? 'PASS' : 'FAIL';
    console.log(`Test 3 Result: ${results['Test 3: Unarchive Note']} (In MyNotes: ${inMyNotes3}, In Archive: ${inArchive3}, In Trash: ${inTrash3})`);

    // -------------------------------------------------------------
    // TEST 4: Delete Note -> Trash
    // -------------------------------------------------------------
    console.log('\n--- Running TEST 4: Delete Note (Move to Trash) ---');
    const deleteRes = await apiRequest(`/notes/${noteId}`, 'DELETE', null, token);
    console.log(`Delete API response: softDeleted=${deleteRes.data.softDeleted}`);

    // Verify DB
    const dbNote4 = await Note.findById(noteId);
    const passT4_DB = dbNote4.isTrashed === true && dbNote4.trashedAt instanceof Date && dbNote4.isArchived === false;
    console.log(`DB Verification: isTrashed=${dbNote4.isTrashed}, trashedAt=${dbNote4.trashedAt}, isArchived=${dbNote4.isArchived} -> ${passT4_DB ? 'PASS' : 'FAIL'}`);

    // Verify API filtering
    const myNotesRes4 = await apiRequest('/notes?filter=mine', 'GET', null, token);
    const inMyNotes4 = myNotesRes4.data.notes.some(n => n._id === noteId);
    const archiveRes4 = await apiRequest('/notes?filter=archived', 'GET', null, token);
    const inArchive4 = archiveRes4.data.notes.some(n => n._id === noteId);
    const trashRes4 = await apiRequest('/notes?filter=trash', 'GET', null, token);
    const inTrash4 = trashRes4.data.notes.some(n => n._id === noteId);

    const passT4 = passT4_DB && !inMyNotes4 && !inArchive4 && inTrash4;
    results['Test 4: Delete -> Trash'] = passT4 ? 'PASS' : 'FAIL';
    console.log(`Test 4 Result: ${results['Test 4: Delete -> Trash']} (In MyNotes: ${inMyNotes4}, In Archive: ${inArchive4}, In Trash: ${inTrash4})`);

    // -------------------------------------------------------------
    // TEST 5: Restore Note from Trash -> Active Notes
    // -------------------------------------------------------------
    console.log('\n--- Running TEST 5: Restore from Trash ---');
    await apiRequest(`/notes/${noteId}/restore`, 'PATCH', {}, token);

    // Verify DB
    const dbNote5 = await Note.findById(noteId);
    const passT5_DB = dbNote5.isTrashed === false && dbNote5.trashedAt === null && dbNote5.isArchived === false && dbNote5.archivedAt === null;
    console.log(`DB Verification: isTrashed=${dbNote5.isTrashed}, trashedAt=${dbNote5.trashedAt}, isArchived=${dbNote5.isArchived} -> ${passT5_DB ? 'PASS' : 'FAIL'}`);

    // Verify API filtering
    const myNotesRes5 = await apiRequest('/notes?filter=mine', 'GET', null, token);
    const inMyNotes5 = myNotesRes5.data.notes.some(n => n._id === noteId);
    const archiveRes5 = await apiRequest('/notes?filter=archived', 'GET', null, token);
    const inArchive5 = archiveRes5.data.notes.some(n => n._id === noteId);
    const trashRes5 = await apiRequest('/notes?filter=trash', 'GET', null, token);
    const inTrash5 = trashRes5.data.notes.some(n => n._id === noteId);

    const passT5 = passT5_DB && inMyNotes5 && !inArchive5 && !inTrash5;
    results['Test 5: Restore from Trash'] = passT5 ? 'PASS' : 'FAIL';
    console.log(`Test 5 Result: ${results['Test 5: Restore from Trash']} (In MyNotes: ${inMyNotes5}, In Archive: ${inArchive5}, In Trash: ${inTrash5})`);

    // -------------------------------------------------------------
    // TEST 6: Archive Note then Verify Trash
    // -------------------------------------------------------------
    console.log('\n--- Running TEST 6: Archive Then Verify Trash ---');
    await apiRequest(`/notes/${noteId}/archive`, 'PATCH', {}, token);
    const trashRes6 = await apiRequest('/notes?filter=trash', 'GET', null, token);
    const notInTrash6 = !trashRes6.data.notes.some(n => n._id === noteId);
    results['Test 6: Archive not in Trash'] = notInTrash6 ? 'PASS' : 'FAIL';
    console.log(`Test 6 Result: ${results['Test 6: Archive not in Trash']} (Not in Trash: ${notInTrash6})`);

    // -------------------------------------------------------------
    // TEST 7: Delete Then Verify Archive
    // -------------------------------------------------------------
    console.log('\n--- Running TEST 7: Delete Then Verify Archive ---');
    // Currently noteId is archived. Now delete it!
    await apiRequest(`/notes/${noteId}`, 'DELETE', null, token);
    const archiveRes7 = await apiRequest('/notes?filter=archived', 'GET', null, token);
    const notInArchive7 = !archiveRes7.data.notes.some(n => n._id === noteId);
    const inTrash7 = (await apiRequest('/notes?filter=trash', 'GET', null, token)).data.notes.some(n => n._id === noteId);
    const passT7 = notInArchive7 && inTrash7;
    results['Test 7: Trash not in Archive'] = passT7 ? 'PASS' : 'FAIL';
    console.log(`Test 7 Result: ${results['Test 7: Trash not in Archive']} (Not in Archive: ${notInArchive7}, In Trash: ${inTrash7})`);

    // -------------------------------------------------------------
    // TEST 8: Edge Case - Restore previously archived-then-deleted note
    // -------------------------------------------------------------
    console.log('\n--- Running TEST 8: Edge Case - Restore previously archived note from Trash ---');
    // It was archived, then deleted to trash. When restored, it MUST go to Active, NOT Archive!
    await apiRequest(`/notes/${noteId}/restore`, 'PATCH', {}, token);
    const dbNote8 = await Note.findById(noteId);
    const passT8_DB = dbNote8.isTrashed === false && dbNote8.isArchived === false;
    const inMyNotes8 = (await apiRequest('/notes?filter=mine', 'GET', null, token)).data.notes.some(n => n._id === noteId);
    const inArchive8 = (await apiRequest('/notes?filter=archived', 'GET', null, token)).data.notes.some(n => n._id === noteId);
    const inTrash8 = (await apiRequest('/notes?filter=trash', 'GET', null, token)).data.notes.some(n => n._id === noteId);
    const passT8 = passT8_DB && inMyNotes8 && !inArchive8 && !inTrash8;
    results['Test 8: Edge case restored to Active'] = passT8 ? 'PASS' : 'FAIL';
    console.log(`Test 8 Result: ${results['Test 8: Edge case restored to Active']} (In MyNotes: ${inMyNotes8}, In Archive: ${inArchive8}, In Trash: ${inTrash8})`);

    // -------------------------------------------------------------
    // TEST 9: Forbid Editing Trashed Note
    // -------------------------------------------------------------
    console.log('\n--- Running TEST 9: Forbid Editing Trashed Note ---');
    await apiRequest(`/notes/${noteId}`, 'DELETE', null, token);
    const editAttemptRes = await apiRequest(`/notes/${noteId}`, 'PATCH', { content: 'Hacked trashed content' }, token);
    const editBlocked = editAttemptRes.status === 400;
    results['Test 9: Forbid edit on trashed note'] = editBlocked ? 'PASS' : 'FAIL';
    console.log(`Test 9 Result: ${results['Test 9: Forbid edit on trashed note']} (Edit blocked with 400: ${editBlocked})`);

    // Restore note for subsequent tests
    await apiRequest(`/notes/${noteId}/restore`, 'PATCH', {}, token);

    // -------------------------------------------------------------
    // TEST 10: Regression - Tags, Pinning, Sharing, Permissions, Search
    // -------------------------------------------------------------
    console.log('\n--- Running TEST 10: Regression Check (Tags, Pin, Share, Search) ---');

    // 10a: Pinning
    const pinRes = await apiRequest(`/notes/${noteId}`, 'PATCH', { isPinned: true }, token);
    const pinnedNotes = (await apiRequest('/notes?filter=pinned', 'GET', null, token)).data.notes;
    const passPin = pinRes.data.isPinned === true && pinnedNotes.some(n => n._id === noteId);
    console.log(`10a Pinning: ${passPin ? 'PASS' : 'FAIL'}`);

    // 10b: Tags
    const tagsRes = await apiRequest('/notes/tags', 'GET', null, token);
    const passTags = tagsRes.data.tags.includes('work');
    console.log(`10b Tags: ${passTags ? 'PASS' : 'FAIL'} (Tags: ${JSON.stringify(tagsRes.data.tags)})`);

    // 10c: Search
    const searchRes = await apiRequest('/notes?filter=all&search=active', 'GET', null, token);
    const passSearch = searchRes.data.notes.some(n => n._id === noteId);
    console.log(`10c Search: ${passSearch ? 'PASS' : 'FAIL'}`);

    // 10d: Sharing
    await apiRequest(`/notes/${noteId}/share`, 'POST', {
      email: collabEmail,
      permission: 'editor'
    }, token);

    const sharedWithCollab = (await apiRequest('/notes?filter=shared', 'GET', null, collabToken)).data.notes;
    const passShare = sharedWithCollab.some(n => n._id === noteId);
    console.log(`10d Sharing: ${passShare ? 'PASS' : 'FAIL'}`);

    // 10e: Collaborator Editor update
    const collabEditRes = await apiRequest(`/notes/${noteId}`, 'PATCH', {
      content: 'Collaborator updated content'
    }, collabToken);
    const passCollabEdit = collabEditRes.data.content === 'Collaborator updated content';
    console.log(`10e Collaborator Edit: ${passCollabEdit ? 'PASS' : 'FAIL'}`);

    const passT10 = passPin && passTags && passSearch && passShare && passCollabEdit;
    results['Test 10: Tags, Pin, Sharing, Search regression'] = passT10 ? 'PASS' : 'FAIL';

    // -------------------------------------------------------------
    // TEST 11: Permanent Delete from Trash
    // -------------------------------------------------------------
    console.log('\n--- Running TEST 11: Permanent Delete in Trash ---');
    // Move to trash
    await apiRequest(`/notes/${noteId}`, 'DELETE', null, token);
    // Second delete permanently deletes
    const permDeleteRes = await apiRequest(`/notes/${noteId}`, 'DELETE', null, token);
    const passPermDeleteAPI = permDeleteRes.data.softDeleted === false;
    const dbNoteAfterDelete = await Note.findById(noteId);
    const passPermDeleteDB = dbNoteAfterDelete === null;
    const passT11 = passPermDeleteAPI && passPermDeleteDB;
    results['Test 11: Permanent Delete from Trash'] = passT11 ? 'PASS' : 'FAIL';
    console.log(`Test 11 Result: ${results['Test 11: Permanent Delete from Trash']} (DB deleted: ${passPermDeleteDB})`);

    // Clean up test users
    await User.findByIdAndDelete(userId);
    await User.findByIdAndDelete(regCollab.data.user._id || regCollab.data.user.id);
    console.log('\n🧹 Cleaned up test users from database.');

  } catch (error) {
    console.error('❌ Test execution encountered error:', error);
  } finally {
    await mongoose.disconnect();
  }

  console.log('\n====================================================');
  console.log('📊 FINAL TEST RESULTS SUMMARY');
  console.log('====================================================');
  console.table(results);

  const allPassed = Object.values(results).length >= 10 && Object.values(results).every(r => r === 'PASS');
  console.log(`\nOVERALL STATUS: ${allPassed ? 'ALL TESTS PASSED ✅' : 'FAILURES DETECTED ❌'}`);
  process.exit(allPassed ? 0 : 1);
}

runTests();
