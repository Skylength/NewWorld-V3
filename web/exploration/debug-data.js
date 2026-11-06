/** Pure projections of recorded evidence. Never infer unrecorded stage durations or historical facts. */
const stages = [
  ['context', '输入与背景'], ['structure', '结构判断'], ['validation', '结构校验'],
  ['text', '文本叙述'], ['commit', '提交世界'],
];
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const parsed = value => { try { return JSON.parse(value); } catch { return null; } };

export function deriveStages(run) {
  if (run && !Array.isArray(run.calls)) {
    return [
      { id:'structure',label:'历史运行（未拆分）',status:run.status,call:run,model:run.model || null,durationMs:null,legacy:true },
      { id:'commit',label:'提交结果',status:run.status === 'completed' ? 'completed' : 'pending',call:null,model:null,durationMs:null,legacy:true },
    ];
  }
  const activeId = run?.failureStage || (run?.stage === 'done' ? 'commit' : run?.stage);
  const activeIndex = stages.findIndex(([id]) => id === activeId);
  return stages.map(([id,label], index) => {
    const call = run?.calls?.find(item => item.role === id) || null;
    let status = !run ? 'pending' : 'unknown';
    if (run?.status === 'completed') status = 'completed';
    else if (activeIndex >= 0) {
      status = index < activeIndex ? 'completed' : index > activeIndex ? 'pending' : run.status;
    } else if (call) status = call.status;
    // A final call can still fail a later format check. failureStage is authoritative for that outcome.
    return { id,label,status,call,model:call?.model || null,durationMs:finite(call?.durationMs) ? call.durationMs : null,legacy:false };
  });
}

export function buildTimeline(run, nowMs = Date.now()) {
  if (!run) return { totalMs:null,bars:[],otherMs:null,unrecorded:0,live:false };
  const start = timestamp(run.startedAt);
  const running = run.status === 'running';
  const finish = timestamp(run.finishedAt);
  const reported = finite(run.durationMs) ? run.durationMs : null;
  const total = reported ?? (start !== null && running ? Math.max(0,nowMs-start) : start !== null && finish !== null ? Math.max(0,finish-start) : null);
  if (!Array.isArray(run.calls)) return { totalMs:total,bars:[],otherMs:null,unrecorded:run.modelRequests || 0,live:running };
  const bars=[];
  let unrecorded=0;
  for(const call of run.calls) {
    const callStart=timestamp(call.startedAt);
    const callFinish=timestamp(call.finishedAt);
    const live=call.status==='running' && running;
    const duration=finite(call.durationMs) ? call.durationMs : callStart!==null && live ? Math.max(0,nowMs-callStart) : callStart!==null && callFinish!==null ? Math.max(0,callFinish-callStart) : null;
    if(start===null || callStart===null || duration===null || callStart<start) {unrecorded++;continue;}
    bars.push({role:call.role,model:call.model,status:call.status,startMs:callStart-start,durationMs:duration,endMs:callStart-start+duration,left:0,width:0,live});
  }
  const span=Math.max(total??0,...bars.map(bar=>bar.endMs),1);
  for(const bar of bars){bar.left=bar.startMs/span*100;bar.width=bar.durationMs/span*100;}
  // Measure union, so unexpected overlapping records cannot produce a negative residual.
  let covered=0,end=0;
  for(const bar of [...bars].sort((a,b)=>a.startMs-b.startMs)) {
    covered+=Math.max(0,bar.endMs-Math.max(end,bar.startMs));end=Math.max(end,bar.endMs);
  }
  return {totalMs:total,bars,otherMs:total!==null && !unrecorded ? Math.max(0,total-covered) : null,unrecorded,live:running};
}

export function contextBreakdown(context) {
  if(!context) return {total:0,segments:[]};
  const total=context.systemPrompt.length+context.userPrompt.length;
  const segments=[{id:'system',label:'系统指令',kind:'system',characters:context.systemPrompt.length,text:context.systemPrompt,reason:'本次请求的完整系统指令'}];
  for(const module of context.modules) segments.push({id:module.id,label:module.title,kind:module.kind,characters:module.text.length,text:module.text,reason:module.reason});
  const framing=context.userPrompt.length-context.modules.reduce((sum,module)=>sum+module.text.length,0);
  let cursor=0;
  const exact=context.modules.every(module=>{
    const found=context.userPrompt.indexOf(module.text,cursor);
    if(found<0)return false;
    cursor=found+module.text.length;return true;
  });
  // For legacy contexts where modules were not a direct decomposition, show the actual message as one segment.
  if(framing<0 || !exact) segments.splice(1,segments.length-1,{id:'user-message',label:'完整输入',kind:'framing',characters:context.userPrompt.length,text:context.userPrompt,reason:'此历史记录无法按模块精确拆分'});
  else segments.push({id:'framing',label:'行动与消息结构',kind:'framing',characters:framing,text:context.userPrompt,reason:'玩家行动、标签、序列化与消息分隔；详情展示完整输入，长度只计其余部分'});
  return {total,segments:segments.map(segment=>({...segment,percent:total?segment.characters/total*100:0}))};
}

export function compareContexts(before, after) {
  const oldMap=new Map((before?.modules||[]).map(m=>[m.id,m]));
  const newMap=new Map((after?.modules||[]).map(m=>[m.id,m]));
  return [...new Set([...oldMap.keys(),...newMap.keys()])].map(id=>{
    const a=oldMap.get(id),b=newMap.get(id),source=b||a;
    return {id,title:source.title,kind:source.kind,status:!a?'added':!b?'removed':a.text!==b.text?'changed':'unchanged',before:a?.text??null,after:b?.text??null,reason:source.reason};
  });
}

function historicalNames(run) {
  const names=new Map();
  for(const module of run.context?.modules||[]) {
    if(module.kind==='registry') {
      const entries=parsed(module.text);
      if(Array.isArray(entries)) for(const entry of entries) if(entry?.id && entry?.name) names.set(entry.id,entry.name);
    }
  }
  for(const module of run.context?.modules||[]) if(module.kind==='location'||module.kind==='related') {
    const value=parsed(module.text);
    const id=value?.id || module.id.replace(/^(location|related):/,'');
    if(id) names.set(id,value?.name||module.title);
  }
  // Invalid candidates can reuse an existing ID. Never overwrite its recorded historical name.
  for(const region of run.draft?.createRegions||[]) if(!names.has(region.id)) names.set(region.id,region.name);
  for(const change of run.changes||[]) if(change.kind==='created') {
    const value=parsed(change.after);
    if(value?.id && value?.name)names.set(value.id,value.name);
  }
  return names;
}

export function runOutcome(run) {
  if(!run)return {committed:false,from:{id:'',name:'未记录'},to:{id:'',name:'未记录'},groups:[],changeCount:0};
  const names=historicalNames(run);
  const committed=run.status==='completed';
  const moved=run.changes?.find(change=>change.kind==='moved');
  const fromId=moved?.before||run.sourceRegionId||run.context?.activeRegionIds?.at(-1)||'';
  const toId=committed ? moved?.after||run.draft?.destinationId||fromId : run.draft?.destinationId||fromId;
  const location=id=>({id,name:names.get(id)||id||'未记录'});
  const changes=committed?[...(run.changes||[])]:[];
  if(!committed && run.draft){
    for(const region of run.draft.createRegions||[])changes.push({kind:'created',regionId:region.id,label:'候选新区域',before:null,after:JSON.stringify(region,null,2)});
    for(const update of run.draft.enrichRegions||[]){
      for(const detail of update.addDetails||[])changes.push({kind:'enriched',regionId:update.id,label:update.reason,before:null,after:detail});
      for(const hint of update.addOpportunities||[])changes.push({kind:'enriched',regionId:update.id,label:'候选互动线索',before:null,after:hint});
      const contextRecords=(run.context?.modules||[]).flatMap(m=>{
        const value=parsed(m.text);
        return m.kind==='registry' && Array.isArray(value)?value:[value];
      });
      const contextRegion=contextRecords.find(value=>value?.id===update.id);
      for(const [key,value] of Object.entries(update.stateChanges||{}))changes.push({kind:'state',regionId:update.id,label:key,before:contextRegion ? contextRegion.state?.[key]??null : '原值未随该请求记录',after:value});
    }
    if(fromId!==toId)changes.push({kind:'moved',regionId:toId,label:'候选移动',before:fromId,after:toId});
  }
  const groups=[];
  for(const change of changes){
    let group=groups.find(item=>item.regionId===change.regionId);
    if(!group){group={regionId:change.regionId,name:names.get(change.regionId)||change.regionId,changes:[]};groups.push(group);}
    group.changes.push({kind:change.kind,label:change.label,before:change.before,after:change.after});
  }
  return {committed,from:location(fromId),to:location(toId),groups,changeCount:changes.length};
}

export function filterRuns(runs,{status='all',query=''}={}) {
  const search=query.trim().toLocaleLowerCase();
  return [...runs].reverse().filter(run=>(status==='all'||run.status===status)&&(!search||[run.action,run.id,run.model,run.error||''].join(' ').toLocaleLowerCase().includes(search)));
}

export function runMetrics(run) {
  if(!run)return {durationMs:null,requests:0,knownTokens:null,usageComplete:false,callCount:0};
  const calls=run.calls;
  const known=calls?.filter(c=>finite(c.usage?.totalTokens))||[];
  const total=run.usage?.totalTokens;
  return {
    durationMs:finite(run.durationMs)?run.durationMs:null,
    requests:run.modelRequests||0,
    knownTokens:Array.isArray(calls)?known.length?known.reduce((sum,c)=>sum+c.usage.totalTokens,0):null:finite(total)?total:null,
    usageComplete:run.status!=='running' && (Array.isArray(calls)?Boolean(calls.length)&&known.length===calls.length:finite(total)),
    callCount:calls?.length??(run.modelRequests?1:0),
  };
}
