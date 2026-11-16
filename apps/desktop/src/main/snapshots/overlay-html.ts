/** Offline, sandboxed display only: no preload, navigation, network or filesystem access. */
export const SNAPSHOT_OVERLAY_HTML = String.raw`<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;pointer-events:none;color:#eee;font:12px system-ui}
#preview{position:absolute;pointer-events:none;transform-origin:50% 50%;will-change:transform,opacity;opacity:0}
#viewport{position:absolute;left:0;top:50%;transform:translateY(-50%);width:100%;overflow:hidden;border-radius:12px;box-shadow:0 18px 54px #0005;outline:1px solid #ffffff30}
img{display:block;width:100%;height:100%;object-fit:cover}
#receipt{position:absolute;display:flex;align-items:center;gap:10px;width:192px;height:48px;box-sizing:border-box;padding:10px;border-radius:10px;background:#1b1b1bf5;border:1px solid #ffffff26;box-shadow:0 6px 24px #0003;opacity:0}
#receipt img{width:28px;height:28px;border-radius:6px;flex-shrink:0}#label{white-space:nowrap}
</style></head><body><div id="preview" aria-hidden="true"><div id="viewport"><img id="image" alt=""></div></div><div id="receipt" role="status"><img id="thumb" alt=""><span id="label">Saved to Ari</span></div>
<script>
let presentation, started=false, savedLabel='Saved to Ari';
window.updateSnapshotDestination = function(value){if(!started)presentation=value};
window.snapshotAttached = function(){savedLabel='Added to draft';document.getElementById('label').textContent=savedLabel};
window.beginSnapshotFeedback = async function(value){
  presentation=value;
  const preview=document.getElementById('preview'),viewport=document.getElementById('viewport'),receipt=document.getElementById('receipt');
  document.getElementById('image').src=value.image;document.getElementById('thumb').src=value.image;
  if(value.sound){try{const context=new AudioContext(),oscillator=context.createOscillator(),gain=context.createGain();oscillator.type='triangle';oscillator.frequency.setValueAtTime(900,context.currentTime);oscillator.frequency.exponentialRampToValueAtTime(340,context.currentTime+.06);gain.gain.setValueAtTime(.025,context.currentTime);gain.gain.exponentialRampToValueAtTime(.0001,context.currentTime+.085);oscillator.connect(gain).connect(context.destination);oscillator.start();oscillator.stop(context.currentTime+.09);oscillator.onended=()=>context.close()}catch{}}
  if(!value.animation){await new Promise(resolve=>setTimeout(resolve,200));return}
  await document.getElementById('image').decode().catch(()=>{});
  await new Promise(resolve=>setTimeout(resolve,160));
  started=true;const p=presentation;
  Object.assign(preview.style,{left:p.left+'px',top:p.top+'px',width:p.width+'px',height:p.width+'px'});
  viewport.style.height=p.height+'px';
  Object.assign(receipt.style,{left:p.receipt.x+'px',top:p.receipt.y+'px'});
  document.getElementById('label').textContent=savedLabel;
  if(p.reducedMotion||matchMedia('(prefers-reduced-motion: reduce)').matches){receipt.style.opacity='1';await new Promise(resolve=>setTimeout(resolve,950));return}
  const timing={duration:p.duration,easing:'linear',fill:'forwards'};
  const flight=preview.animate(p.frames.flight,timing),crop=viewport.animate(p.frames.crop,timing);
  const receiptAnimation=p.composer?null:receipt.animate(p.frames.handoff,timing);
  await Promise.all([flight.finished,crop.finished,...(receiptAnimation?[receiptAnimation.finished]:[])]);
  if(!p.composer){await new Promise(resolve=>setTimeout(resolve,850));await receipt.animate([{opacity:1},{opacity:0}],{duration:180,fill:'forwards'}).finished}
};
</script></body></html>`
