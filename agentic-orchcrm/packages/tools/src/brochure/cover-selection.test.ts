import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCoverPhoto, partitionEditorialPhotos, deduplicatePhotoTags } from './cover-selection.js';

test('cover selection varies within destination candidates', () => {
  assert.equal(selectCoverPhoto([], ['fort', 'beach', 'fort'], () => 0), 'fort');
  assert.equal(selectCoverPhoto([], ['fort', 'beach', 'fort'], () => .9), 'beach');
});
test('uploaded photography retains priority and empty searches are safe', () => {
  assert.equal(selectCoverPhoto(['chosen'], ['search'], () => .9), 'chosen');
  assert.equal(selectCoverPhoto([], []), '');
});
test('overview and extras cannot reuse cover or day photography', () => {
  assert.deepEqual(partitionEditorialPhotos(['hero','day','town','town','beach'], 'hero', ['day']),
    {overviewPhotos:['town','beach'],extraPhotos:[]});
});
test('repeated photo tokens and aliases are removed without touching logos', () => {
  const html='<img src="OVERVIEW_PHOTO_1"><img src="OVERVIEW_PHOTO_2"><img src="DAY_2_PHOTO"><img src="SCHOOL_LOGO"><img src="SCHOOL_LOGO">';
  assert.equal(deduplicatePhotoTags(html,{OVERVIEW_PHOTO_1:'a',OVERVIEW_PHOTO_2:'a',DAY_2_PHOTO:'b'}),
    '<img src="OVERVIEW_PHOTO_1"><img src="DAY_2_PHOTO"><img src="SCHOOL_LOGO"><img src="SCHOOL_LOGO">');
});
