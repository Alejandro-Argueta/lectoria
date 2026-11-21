(() => {
  const $ = id => document.getElementById(id);
  const cfg = window.LECTORIA_CONFIG || {};
  let supabase, currentUser, currentRole, books=[], selectedFiles=[], activeBook=null, pdfDoc=null, signedUrl=null;
  let fontSize=19, theme='light', progressTimer=null, progressListenerAttached=false;

  const show = (id, yes=true) => $(id).classList.toggle('hidden', !yes);
  const message = (id, text, error=false) => { $(id).textContent=text; $(id).classList.toggle('error',error); };
  const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const isAdmin = () => currentRole === 'admin';

  async function init(){
    if (!window.supabase || !cfg.supabaseUrl || !cfg.supabaseAnonKey || cfg.supabaseUrl.includes('TU-PROYECTO')) {
      message('loginError','Configura assets/js/config.js con las credenciales de Supabase.',true); return;
    }
    supabase = window.supabase.createClient(cfg.supabaseUrl,cfg.supabaseAnonKey);
    const {data:{session}} = await supabase.auth.getSession();
    if(session) await enter(session.user); else show('loginView');
    supabase.auth.onAuthStateChange((_event,session)=>{ if(session) enter(session.user); else {currentUser=null;show('appView',false);show('loginView');} });
  }

  async function enter(user){
    currentUser=user;
    const {data:profile,error}=await supabase.from('profiles').select('role,display_name').eq('id',user.id).single();
    if(error || !profile){await supabase.auth.signOut();message('loginError','Esta cuenta no está autorizada para Lectoria.',true);return;}
    currentRole=profile.role;
    $('userEmail').textContent=profile.display_name || user.email;
    $('avatar').textContent=(profile.display_name || user.email || 'L').slice(0,1).toUpperCase();
    show('adminNav',true); show('importShortcut',true);
    show('loginView',false);show('appView');
    await loadBooks(); navigate('library');
  }

  $('loginForm').addEventListener('submit',async e=>{
    e.preventDefault();message('loginError','');
    const {error}=await supabase.auth.signInWithPassword({email:$('email').value.trim(),password:$('password').value});
    if(error) message('loginError','No se pudo iniciar sesión. Revisa tus credenciales.',true);
  });
  $('logoutBtn').addEventListener('click',()=>supabase.auth.signOut());
  document.querySelectorAll('[data-page]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.page)));
  $('importShortcut').addEventListener('click',()=>navigate('admin'));
  $('backLibrary').addEventListener('click',()=>navigate('library'));

  function navigate(page){
    ['libraryPage','continuePage','adminPage','readerPage'].forEach(id=>show(id,false));
    document.querySelectorAll('[data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===page));
    // Todas las cuentas autorizadas pueden importar libros; borrar sigue reservado al administrador en RLS.
    if(page==='admin'&&!currentUser) page='library';
    if(page==='library') show('libraryPage');
    if(page==='continue'){show('continuePage');renderContinue();}
    if(page==='admin') show('adminPage');
  }

  async function loadBooks(){
    const {data,error}=await supabase.from('books').select('id,title,original_name,storage_path,file_size,created_at').order('created_at',{ascending:false});
    if(error){console.error(error);return;}
    books=data||[];renderBooks();
  }
  function card(book){
    return `<button class="book-card" data-book="${book.id}"><div class="cover"><span class="cover-monogram">L.</span><strong>${escapeHtml(book.title)}</strong><small>LECTORIA · PDF</small></div><span class="book-card-title">${escapeHtml(book.title)}</span><small class="muted">PDF · ${(book.file_size/1048576).toFixed(1)} MB</small></button>`;
  }
  function bindCards(container){container.querySelectorAll('[data-book]').forEach(b=>b.addEventListener('click',()=>openBook(b.dataset.book)));}
  function renderBooks(){
    const term=$('searchInput').value.toLowerCase();
    const filtered=books.filter(b=>b.title.toLowerCase().includes(term));
    $('bookGrid').innerHTML=filtered.map(card).join('');
    $('bookCount').textContent=`${books.length} libros`;
    show('emptyState',books.length===0);bindCards($('bookGrid'));
  }
  function renderContinue(){
    supabase.from('reading_progress').select('book_id,progress_percent,updated_at').eq('user_id',currentUser.id).gt('progress_percent',0).order('updated_at',{ascending:false}).then(({data})=>{
      const rows=data||[];const items=rows.map(r=>books.find(b=>b.id===r.book_id)).filter(Boolean);
      $('continueGrid').innerHTML=items.map(card).join('')||'<p class="muted">Todavía no tienes lecturas en curso.</p>';bindCards($('continueGrid'));
    });
  }
  $('searchInput').addEventListener('input',renderBooks);

  const input=$('pdfInput'), zone=$('dropzone');
  input.addEventListener('change',()=>{selectedFiles=[...input.files];renderSelected();});
  ['dragenter','dragover'].forEach(ev=>zone.addEventListener(ev,e=>{e.preventDefault();zone.classList.add('dragover');}));
  ['dragleave','drop'].forEach(ev=>zone.addEventListener(ev,e=>{e.preventDefault();zone.classList.remove('dragover');}));
  zone.addEventListener('drop',e=>{selectedFiles=[...e.dataTransfer.files].filter(f=>f.type==='application/pdf'||f.name.toLowerCase().endsWith('.pdf'));renderSelected();});
  function renderSelected(){
    $('selectedFiles').innerHTML=selectedFiles.map(f=>`<div class="file-row"><span>${escapeHtml(f.name)}</span><small>${(f.size/1048576).toFixed(1)} MB</small></div>`).join('');
    $('uploadBtn').disabled=!selectedFiles.length;
    $('uploadBtn').textContent=`Importar ${selectedFiles.length} PDF`;
  }
  $('uploadBtn').addEventListener('click',uploadFiles);
  async function uploadFiles(){
    $('uploadBtn').disabled=true;
    let done=0, errors=[];
    for(const file of selectedFiles){
      if(file.size>50*1024*1024){errors.push(file.name+': supera 50 MB');continue;}
      const id=crypto.randomUUID(), path=`${currentUser.id}/${id}.pdf`;
      const {error:storageError}=await supabase.storage.from('books').upload(path,file,{contentType:'application/pdf',upsert:false});
      if(storageError){errors.push(file.name+': '+storageError.message);continue;}
      const title=file.name.replace(/\.pdf$/i,'');
      const {error:dbError}=await supabase.from('books').insert({id,title,original_name:file.name,storage_path:path,file_size:file.size,uploaded_by:currentUser.id});
      if(dbError){await supabase.storage.from('books').remove([path]);errors.push(file.name+': '+dbError.message);continue;}
      done++;
    }
    message('uploadStatus',`${done} libro(s) importado(s). ${errors.join(' | ')}`);
    selectedFiles=[];input.value='';renderSelected();await loadBooks();$('uploadBtn').disabled=true;
  }

  async function openBook(id){
    activeBook=books.find(b=>b.id===id);if(!activeBook)return;
    navigate('library');show('libraryPage',false);show('readerPage');
    $('readerTitle').textContent=activeBook.title;$('readerText').innerHTML='';show('pdfFallback',false);message('readerStatus','Preparando el libro…');
    const {data,error}=await supabase.storage.from('books').createSignedUrl(activeBook.storage_path,3600);
    if(error){message('readerStatus','No se pudo abrir el documento.');return;}
    signedUrl=data.signedUrl;
    await renderPdfText(signedUrl);
    await restoreProgress();
  }
  async function renderPdfText(url){
    if(!window.pdfjsLib){
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
    }
    if(!window.pdfjsLib){show('pdfFallback');$('openPdf').href=url;message('readerStatus','No se pudo cargar PDF.js.');return;}
    pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    try{
      pdfDoc=await pdfjsLib.getDocument(url).promise;
      for(let n=1;n<=pdfDoc.numPages;n++){
        const page=await pdfDoc.getPage(n), tc=await page.getTextContent();
        const texts=tc.items.filter(x=>x.str&&x.str.trim()).map(x=>x.str.trim());
        const section=document.createElement('section');section.dataset.page=n;
        const p=document.createElement('p');p.textContent=texts.join(' ');section.append(p);$('readerText').append(section);
      }
      message('readerStatus','');
      if(!progressListenerAttached){window.addEventListener('scroll',saveProgress,{passive:true});progressListenerAttached=true;}
    }catch(e){console.error(e);show('pdfFallback');$('openPdf').href=url;message('readerStatus','Este PDF no permite extraer texto.');}
  }
  function loadScript(src){return new Promise(resolve=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=resolve;document.head.append(s);});}
  async function restoreProgress(){
    const {data}=await supabase.from('reading_progress').select('page_number').eq('user_id',currentUser.id).eq('book_id',activeBook.id).maybeSingle();
    if(data?.page_number){const el=$('readerText').querySelector(`[data-page="${data.page_number}"]`);el?.scrollIntoView();}
  }
  function saveProgress(){
    if(!activeBook)return;
    clearTimeout(progressTimer);
    progressTimer=setTimeout(async()=>{
      const sections=[...$('readerText').querySelectorAll('[data-page]')];
      const current=sections.find(s=>s.getBoundingClientRect().bottom>120);
      if(!current)return;
      const percent=Math.min(100,Math.round((Number(current.dataset.page)/pdfDoc.numPages)*10000)/100);
      await supabase.from('reading_progress').upsert({user_id:currentUser.id,book_id:activeBook.id,page_number:Number(current.dataset.page),progress_percent:percent},{onConflict:'user_id,book_id'});
    },900);
  }

  $('themeBtn').addEventListener('click',()=>{theme=theme==='light'?'sepia':theme==='sepia'?'dark':'light';$('readerPage').dataset.theme=theme;});
  $('fontPlus').addEventListener('click',()=>{fontSize=Math.min(32,fontSize+1);$('readerText').style.fontSize=fontSize+'px';});
  $('fontMinus').addEventListener('click',()=>{fontSize=Math.max(13,fontSize-1);$('readerText').style.fontSize=fontSize+'px';});
  $('readerSettings').addEventListener('click',()=>$('readerSettingsPanel').classList.toggle('hidden'));
  // En móviles permite ocupar toda la pantalla disponible y, si el navegador lo admite, activar fullscreen real.
  $('readerFullscreen').addEventListener('click',async()=>{
    const page=$('readerPage');
    try{
      if(!document.fullscreenElement && page.requestFullscreen){
        await page.requestFullscreen();
      }else if(document.fullscreenElement && document.exitFullscreen){
        await document.exitFullscreen();
      }else{
        page.classList.toggle('reader-immersive');
      }
    }catch(error){
      page.classList.toggle('reader-immersive');
    }
  });
  document.addEventListener('fullscreenchange',()=>{
    $('readerFullscreen').textContent=document.fullscreenElement?'⤢':'⛶';
    $('readerFullscreen').title=document.fullscreenElement?'Salir de pantalla completa':'Pantalla completa';
    $('readerFullscreen').setAttribute('aria-label',$('readerFullscreen').title);
  });
  $('fontSelect').addEventListener('change',e=>$('readerText').style.fontFamily=e.target.value);
  $('lineSelect').addEventListener('change',e=>$('readerText').style.lineHeight=e.target.value);
  $('widthSelect').addEventListener('change',e=>$('readerText').style.maxWidth=e.target.value);
  init();
})();
