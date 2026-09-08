import {expect,test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {TreeFileIcon} from "./TreeFileIcon";
import {treeFileIconToken} from "./tree-file-icon-token";
import {parseThemeDocument,DEFAULT_THEME} from "../../../../packages/shared/src/theme";

test("tree icon names and compound suffixes take priority over the last extension",()=>{
 for(const [path,token] of Object.entries({"README.MD":"markdown","src/.gitignore":"git","Dockerfile":"docker","bun.lock":"bun",".env.local":"text","note.mdx.tsx":"markdown","src/View.TSX":"react","style.scss":"sass","src/test.ts":"typescript","unknown":"default","no-suffix/":"default","constructor":"default","__proto__":"default","x.constructor":"default"}))expect<string>(treeFileIconToken(path)).toBe(token);
});
test("folder state renders one decorative chevron without a file glyph",()=>{
 const html=renderToStaticMarkup(<TreeFileIcon path="src" folder expanded/>);
 expect(html).toContain('data-expanded="true"');expect(html).not.toContain('data-icon-token');expect(html.match(/<svg/g)).toHaveLength(1);expect(html.match(/<path/g)).toHaveLength(1);expect(html).toContain('aria-hidden="true"');
});
test("tree theme colors and geometry use validated shared theme documents",()=>{
 const tokens={"--trees-icon-blue":"#123456","--trees-file-icon-color-react":"#abcdef","--trees-item-height":"32px","--trees-level-gap-override":"3px","--trees-icon-nudge-override":"-1px"};
 expect(parseThemeDocument({...DEFAULT_THEME,tokens}).tokens).toEqual(tokens);
 for(const value of ["url(https://invalid.example)","red;display:none"])expect(()=>parseThemeDocument({...DEFAULT_THEME,tokens:{"--trees-icon-blue":value}})).toThrow();
 expect(()=>parseThemeDocument({...DEFAULT_THEME,tokens:{"--trees-item-height":"0px"}})).toThrow();
 expect(()=>parseThemeDocument({...DEFAULT_THEME,tokens:{"--trees-icon-nudge-override":"30px"}})).toThrow();
});

test("multiple Next.js tree glyphs keep their gradient references local",()=>{
 const html=renderToStaticMarkup(<><TreeFileIcon path="next.config.js"/><TreeFileIcon path="nested/next.config.js"/></>);
 const ids=[...html.matchAll(/ id="([^"]+)"/g)].map(m=>m[1]),refs=[...html.matchAll(/url\(#([^\)]+)\)/g)].map(m=>m[1]);
 expect(ids).toHaveLength(2);expect(new Set(ids).size).toBe(2);expect(refs.every(id=>ids.includes(id))).toBe(true);
});
