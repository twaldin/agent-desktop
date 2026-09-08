import {expect,test} from 'bun:test';
import {Slice} from 'prosemirror-model';
import {clipboardFileLink,composerClipboardText,parseClipboardText} from './composer-clipboard';
import {composerDocument,readComposerDocument} from './composer-document';

test('native clipboard links round-trip literal path punctuation and repeated mentions with fresh node identities',()=>{
 for(const path of ['/project/file.ts','/project/a b[1](x).ts','/project/@secret#L2?x%20:42.ts','/project/back\\slash]().ts','/project/😀.ts']){
  const wire=clipboardFileLink(path),parsed=parseClipboardText(`before ${wire} and ${wire}\nend`,'work');
  expect(parsed.text).toBe('before  and \nend');expect(parsed.files.map(file=>file.source)).toEqual([{kind:'file',hostId:'work',path},{kind:'file',hostId:'work',path}]);
  expect(parsed.files.map(file=>file.textOffset)).toEqual([7,12]);expect(parsed.files[0]!.id).not.toBe(parsed.files[1]!.id);
  expect(readComposerDocument(composerDocument(parsed.text,parsed.files))).toEqual(parsed);
  expect(composerClipboardText(new Slice(composerDocument(parsed.text,parsed.files).content,0,0))).toBe(`before ${wire} and ${wire}\nend`);
 }
});
test('clipboard restores only absolute local path links and rejects invalid local references without guessing',()=>{
 const text='[site](https://example.com) [relative](README.md) [mail](mailto:a@b) escaped \\[file](/project/file.ts)';
 expect(parseClipboardText(text,'work')).toEqual({text,files:[]});
 expect(()=>parseClipboardText('[file](/project/../secret)','work')).toThrow();
 expect(()=>parseClipboardText('[file](/project/file.ts)')).toThrow('Choose a host');
 expect(parseClipboardText('[incomplete](/project/file.ts','work').files).toHaveLength(0);
});
