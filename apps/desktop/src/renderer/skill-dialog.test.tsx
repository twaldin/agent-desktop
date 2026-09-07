import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { skillDocument } from "./NativeSkillDialog";
import { MarkdownText } from "./MarkdownText";
import { DraftController } from "./drafts";
import { prepareSkillDraft } from "./skill-draft";
import { projectExecutionModeDraftId } from "./project-execution-mode";
import type { ComposerAction, Draft } from "@agent-desktop/shared";

test("skill documents remove only complete frontmatter and render untrusted body as inert Markdown", () => {
  const body = '# Instructions\n\nUse **native** skills.\n\n<script>window.stolen=true</script>\n\n[bad](javascript:alert(1))';
  expect(skillDocument(`\uFEFF---\r\nname: skill\r\n---\r\n${body}`)).toBe(body);
  expect(skillDocument(`---\n---\n${body}`)).toBe(body);
  expect(skillDocument('---\nname: unfinished\n# Body')).toBe('---\nname: unfinished\n# Body');
  const html = renderToStaticMarkup(<MarkdownText text={skillDocument(`---\nname: skill\n---\n${body}`)} blockKey="skill-test"/>);
  expect(html).toContain('<strong>native</strong>');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('href="javascript:');
});

test("skill Try preserves existing drafts across offline restore and rejects disabled invocation without edits", () => {
  const values = new Map<string,string>(); const cache={read:(key:string)=>values.get(key)??null,write:(key:string,value:string)=>{values.set(key,value);}};
  const send=async()=>{throw new Error('Offline Try must not send a command');};
  const controller=new DraftController(send,'owner',cache);
  const original:Draft={id:'new-conversation',revision:3,text:'Keep this\nunsent prompt',projectId:'project',model:{provider:'native',id:'choice'},thinkingLevel:'high',attachments:[],updatedAt:1};
  const action:ComposerAction={id:'skill-one',name:'one',description:'One',insertText:'/skill:one ',source:{kind:'skill',label:'Project'},availability:'executable',argumentCompletions:false};
  controller.ingest(original);controller.ingest({...original,id:'session:other',text:'Other session draft'});
  prepareSkillDraft(controller,action,'project');
  expect(controller.get('new-conversation').draft).toMatchObject({...original,text:'/skill:one Keep this\nunsent prompt'});
  expect(controller.get('session:other').draft.text).toBe('Other session draft');
  controller.dispose();
  const restored=new DraftController(send,'owner',cache);
  const saved=restored.get('new-conversation').draft;
  expect(saved.text).toBe('/skill:one Keep this\nunsent prompt');
  expect(()=>prepareSkillDraft(restored,{...action,availability:'disabled'},'project')).toThrow();
  expect(restored.get('new-conversation').draft).toEqual(saved);
  restored.dispose();
});


test("skill Try switches project through its remembered execution mode before updating text", () => {
  const controller = new DraftController(async () => { throw new Error("Offline only"); }, "owner");
  const oldExecution = {type:"worktree" as const, startingState:{type:"branch" as const,branchName:"old-branch"}};
  const targetExecution = {type:"worktree" as const, startingState:{type:"branch" as const,branchName:"target-branch"}};
  controller.ingest({id:"new-conversation",revision:1,text:"Keep prompt",projectId:"old",model:null,execution:oldExecution,updatedAt:1});
  controller.ingest({id:projectExecutionModeDraftId("target"),revision:2,text:"",projectId:"target",model:null,execution:targetExecution,updatedAt:1});
  const action:ComposerAction={id:"skill",name:"skill",description:"",insertText:"/skill:one ",source:{kind:"skill",label:"Project"},availability:"executable",argumentCompletions:false};
  prepareSkillDraft(controller, action, "target", true);
  expect(controller.get("new-conversation").draft).toMatchObject({projectId:"target",execution:targetExecution,text:"/skill:one Keep prompt"});
  expect(controller.get(projectExecutionModeDraftId("old")).draft.execution).toEqual(oldExecution);
  prepareSkillDraft(controller, action, null, true);
  expect(controller.get("new-conversation").draft).toMatchObject({projectId:null,execution:{type:"local"},text:"/skill:one Keep prompt"});
  controller.dispose();
});
