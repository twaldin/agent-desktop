import {expect,test} from 'bun:test';
import {fromMarkdown} from 'mdast-util-from-markdown';
import {codeFenceOpen} from './transcript-code-fence';

test('fence lifetime follows real parsed code, including containers, literal fences and CRLF',()=>{
  for(const [source,open] of [
    ['```js\nconst a = 1',true], ['```js\nconst a = 1\n```',false],
    ['```\n```',false], ['```\n\n```',false], ['```\n\n\n```',false],
    ['````js\n```',true], ['````js\n```\n````',false],
    ['```\na\n    ```',true], ['```\n    ```\n```',false],
    ['~~~sh\nx\n~~~ extra',true], ['~~~sh\nx\n~~~~',false],
    ['> ```js\n> code\n> ```',false], ['> ```js\n> code\n>     ```',true],
    ['- ```js\n  code\n  ```',false], ['- ```js\n  code',true],
    ['```text\na\r\nb\r\n```',false], ['```\na\n\n',true], ['    indented\n    code',false],
  ] as const){
    const tree=fromMarkdown(source);
    const visit=(node:typeof tree|typeof tree.children[number]):void=>{
      if(node.type==='code')expect(codeFenceOpen(source.slice(node.position!.start.offset!,node.position!.end.offset!),node.value)).toBe(open);
      else if('children' in node)for(const child of node.children)visit(child as typeof tree.children[number]);
    };visit(tree);
  }
});
