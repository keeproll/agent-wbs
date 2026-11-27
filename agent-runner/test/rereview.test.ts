// M4 통합 재리뷰(7021018) N1~N5 재현. 검토자 시험(m4-integration-fix-rereview/review-new.test.ts)의 new: 사례를 그대로 옮겼다.
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { ApiError, type ApiClient } from '../src/api/client.ts';
import { RunnerApp } from '../src/app.ts';
import { createResetCleanup } from '../src/cleanup/reset.ts';
import { createGithubRemoteCleanup } from '../src/cleanup/remote.ts';
import { repositoryIdFor } from '../src/git/identity.ts';
import { GitRepository } from '../src/git/repository.ts';
import { createGitHubClient } from '../src/github/client.ts';
import { sealCredential } from '../src/github/credential.ts';
import { nodeHostSources } from '../src/resources/host.ts';
import { Secret } from '../src/security/secret.ts';
import { State } from '../src/state/state.ts';
import { GitHubModel } from './fakes/github/model.ts';
import { startFakeGitHub } from './fakes/github/server.ts';

let home: string;
let state: State;
beforeEach(async () => { home=await mkdtemp(join(process.env.AWBS_TEST_TMP??tmpdir(),'rereview-')); state=await State.open(home); });
afterEach(async () => { vi.restoreAllMocks(); await state.close(); await rm(home,{recursive:true,force:true}); });
const defer=()=>Promise.withResolvers<undefined>();
const payload=(extra:Record<string,unknown>={})=>({epochPath:'0/',holds:[],generation:null,unparsedPrs:[],...extra});
const command=(p:Record<string,unknown>)=>({id:'c',kind:'reset-cleanup' as const,epoch:0,payload:p});
function git(cwd:string,...args:string[]) {
  return execFileSync('git',['-c','user.name=review','-c','user.email=review@example.invalid','-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false',...args],
  {cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_ALLOW_PROTOCOL:'file'}}).trim();
}
async function repository() {
  const source=join(home,'source'); await mkdir(join(source,'prototype'),{recursive:true}); await mkdir(join(source,'src'));
  git(source,'init','-b','main'); await writeFile(join(source,'prototype/input'),'input'); await writeFile(join(source,'src/a'),'a');
  git(source,'add','.'); git(source,'commit','-m','base'); const base=git(source,'rev-parse','HEAD');
  const url=join(home,'remote.git'); git(source,'clone','--bare',source,url);
  const repo=await GitRepository.clone(home,repositoryIdFor(url),url); return {repo,url,base};
}
function app(api:ApiClient=vi.fn() as unknown as ApiClient,githubFetch?:typeof fetch) {
  return new RunnerApp({state,api,home,version:'review',env:{},warn:()=>undefined,hostSources:nodeHostSources(),
    cliRegistry:{latest:async()=>'1.0.0',install:async()=>undefined,probe:async()=>undefined},
    ...(githubFetch&&{github:{repo:{owner:'o',repo:'current'},mode:'token' as const},githubFetch}),
  });
}

test('N: input copy started before reset must not survive a completed reset',{timeout:15_000},async()=>{
  // 2차 재리뷰(N2) 뒤 입력 복사는 프로젝트 잠금 안에서 한다. 원래 재현처럼 「복사를 멈춘 채 초기화 완료를 기다리면」
  // 초기화가 잠금을 기다리므로 끝나지 않는다(의도된 직렬화). 그래서 초기화를 시작해 둔 뒤 복사를 풀고 결과를 확인한다.
  const {repo,url,base}=await repository();
  const entered=defer(); const release=defer();
  const target=repo as unknown as {tree(commit:string):Promise<unknown>}; const original=target.tree.bind(repo);
  vi.spyOn(target,'tree').mockImplementation(async(commit)=>{entered.resolve(undefined); await release.promise; return original(commit);});
  const copy=repo.checkoutInput('late',base); const copyResult=copy.then(v=>({path:v}),e=>({error:String(e)}));
  await entered.promise;
  const resetting=createResetCleanup({home,identity:()=>({hostId:'h',bootId:'b'})})(command(payload({repoUrl:url,baseCommit:base,branches:[],prs:[]})));
  try {
    await vi.waitFor(async () => {
      expect((await readdir(join(home,'state/git'))).some(name=>name.startsWith(`${repositoryIdFor(url)}.json.lock.`))).toBe(true);
    }, { timeout: 10_000 });
  } finally { release.resolve(undefined); }
  const result=await resetting; const copied=await copyResult;
  expect(result.status).toBe('done');
  await expect(lstat(join(home,'inputs',repositoryIdFor(url),'late'))).rejects.toMatchObject({code:'ENOENT'});
  expect(copied).toHaveProperty('error');
});

test('N: cleanup must not close PRs or delete branches in a different configured repository',async()=>{
  const token='fake-token'; const github=await startFakeGitHub(token); const model=new GitHubModel({owner:'o',repo:'current'});
  model.install(github); model.push('agent/T1'); const pr=model.openPull('agent/T1').number;
  let publicKey='';
  const api=(async(operation:string,request:{body?:{publicKeyPem:string}})=>{
    if(operation==='registerGithubKey'){publicKey=request.body?.publicKeyPem??'';return{status:200,body:{keyId:'key'},headers:new Headers()};}
    if(operation==='getGithubCredential')return{status:200,body:{sealed:sealCredential(publicKey,token)},headers:new Headers()};
    if(operation==='getCommands')return{status:200,body:{currentEpoch:0,commands:[command(payload({repoUrl:'https://github.com/foreign/previous',baseCommit:model.branches.get('main'),branches:['agent/T1'],prs:[pr]}))]},headers:new Headers()};
    return{status:204,body:undefined,headers:new Headers()};
  }) as unknown as ApiClient;
  const a=new RunnerApp({state,api,home,version:'review',env:{},warn:()=>undefined,hostSources:nodeHostSources(),
    cliRegistry:{latest:async()=>'1.0.0',install:async()=>undefined,probe:async()=>undefined},github:{repo:{owner:'o',repo:'current'},mode:'token',baseUrl:github.url}});
  try {
    await a.init(); await a.runner.poll();
    expect(github.requests.filter(r=>r.method==='PATCH'||r.method==='DELETE')).toEqual([]);
    expect(model.pulls.get(pr)?.state).toBe('open'); expect(model.branches.has('agent/T1')).toBe(true);
  } finally {await github.close();}
});

test('N: a rejected DELETE 422 must not allow cleanup done with the branch still present',async()=>{
  const github=await startFakeGitHub('fake'); const model=new GitHubModel(); model.install(github); model.push('agent/protected');
  github.on(`DELETE /repos/${model.owner}/${model.repo}/git/refs/heads/agent/protected`,()=>({status:422,body:{message:'Reference update failed',errors:[{resource:'Reference',code:'custom',message:'Deletion rejected'}]}}));
  const client=createGitHubClient({repo:{owner:model.owner,repo:model.repo},baseUrl:github.url,token:async()=>new Secret('fake')});
  try {
    const result=await createResetCleanup({home,identity:()=>({hostId:'h',bootId:'b'}),remote:createGithubRemoteCleanup({client})})(command(payload({
      repoUrl:`https://github.com/${model.owner}/${model.repo}`,baseCommit:model.branches.get('main'),branches:['agent/protected'],prs:[],
    })));
    expect(result.status).toBe('failed');
  }
  finally {expect(model.branches.has('agent/protected')).toBe(true); await github.close();}
});

test('N: WBS credential authorization failures must stop the running app',{timeout:15_000},async()=>{
  const api=(async(operation:string)=>{
    if(operation==='registerGithubKey')return{status:200,body:{keyId:'key'},headers:new Headers()};
    if(operation==='getGithubCredential')throw new ApiError('getGithubCredential',403,undefined,null);
    return{status:204,body:undefined,headers:new Headers()};
  }) as unknown as ApiClient;
  const a=app(api,vi.fn() as unknown as typeof fetch); const controller=new AbortController();
  vi.spyOn(a.execution,'recover').mockResolvedValue(true);
  vi.spyOn(a.runner,'ready','get').mockReturnValue(true);
  vi.spyOn(a.runner,'run').mockImplementation(signal=>new Promise(resolve=>signal.addEventListener('abort',()=>resolve())));
  vi.spyOn(a,'reportHost').mockResolvedValue(); vi.spyOn(a,'reportModels').mockResolvedValue();
  vi.spyOn(a,'checkReadiness').mockResolvedValue({at:new Date().toISOString(),items:[]});
  vi.spyOn(a,'startSchedules').mockImplementation(()=>undefined);
  let outcome='pending';
  const running=a.run(controller.signal).then(()=>{outcome='resolved';},()=>{outcome='rejected';});
  try {await vi.waitFor(()=>{expect(outcome).toBe('rejected');}, {timeout:10_000});}
  finally {controller.abort();await running;}
});

test('N: crash before command-result durability must not suppress the only manual warning',async()=>{
  const reports:unknown[]=[];
  const api=(async(operation:string,request:{body:unknown})=>{
    if(operation==='getCommands')return{status:200,body:{currentEpoch:0,commands:[command(payload({unparsedPrs:[{source:'runner_jobs',id:'j',value:'unparsed'}]}))]},headers:new Headers()};
    if(operation==='reportCommandResult')reports.push(request.body);
    return{status:204,body:undefined,headers:new Headers()};
  }) as unknown as ApiClient;
  const a=app(api); await a.init(); const enqueue=a.runner.outbox.enqueue.bind(a.runner.outbox); let crash=true;
  vi.spyOn(a.runner.outbox,'enqueue').mockImplementation(async(...args)=>{
    if(args[0]==='reportCommandResult'&&crash){crash=false;throw new Error('simulated crash before outbox write');}
    return enqueue(...args);
  });
  await expect(a.runner.poll()).rejects.toThrow('simulated crash');
  expect(state.snapshot.outbox).toEqual([]);
  await a.runner.poll();
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({items:expect.arrayContaining([expect.objectContaining({name:'warn:manual-reconcile',ok:false})])});
});

test('N5 보강: outbox에 저장된 뒤에는 같은 경고를 다음 초기화에서 다시 싣지 않는다(실제 Runner.poll 경로)',async()=>{
  const reports:{items:{name:string;ok:boolean}[]}[]=[];
  let id=0;
  const api=(async(operation:string,request:{body:unknown})=>{
    if(operation==='getCommands'){id+=1;return{status:200,body:{currentEpoch:0,commands:[{...command(payload({unparsedPrs:[{source:'runner_jobs',id:'j',value:'unparsed'}]})),id:`c${id}`}]},headers:new Headers()};}
    if(operation==='reportCommandResult')reports.push(request.body as {items:{name:string;ok:boolean}[]});
    return{status:204,body:undefined,headers:new Headers()};
  }) as unknown as ApiClient;
  const a=app(api); await a.init();
  await a.runner.poll(); await a.runner.poll();
  expect(reports).toHaveLength(2);
  expect(reports[0]?.items.some(i=>i.name==='warn:manual-reconcile'&&!i.ok)).toBe(true);
  expect(reports[1]?.items.some(i=>!i.ok)).toBe(false);
});
