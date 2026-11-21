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
  const signOut = async () => { await supabase.auth.signOut(); };
  $('logoutBtn').addEventListener('click',signOut);
  $('logoutMobileBtn').addEventListener('click',signOut);
  document.querySelectorAll('[data-page]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.page)));
  $('importShortcut').addEventListener('click',()=>navigate('admin'));
  $('backLibrary').addEventListener('click',()=>{saveProgress();navigate('library');});

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
    const remove = isAdmin()
      ? `<button class="delete-book" type="button" data-delete-book="${book.id}" aria-label="Eliminar ${escapeHtml(book.title)}" title="Eliminar libro">×</button>`
      : '';
    return `<div class="book-card-wrap">
      <button class="book-card" data-book="${book.id}" type="button">
        <div class="cover"><span class="cover-monogram">L.</span><strong>${escapeHtml(book.title)}</strong><small>LECTORIA · PDF</small></div>
        <span class="book-card-title">${escapeHtml(book.title)}</span>
        <small class="muted">PDF · ${(book.file_size/1048576).toFixed(1)} MB</small>
      </button>${remove}</div>`;
  }
  function bindCards(container){
    // Delegación de eventos: sigue funcionando aunque las tarjetas se vuelvan a dibujar.
    if(container.dataset.cardsBound === '1') return;
    container.dataset.cardsBound = '1';
    container.addEventListener('click', event => {
      const deleteButton = event.target.closest('[data-delete-book]');
      if(deleteButton && container.contains(deleteButton)){
        event.preventDefault();
        event.stopPropagation();
        deleteBook(deleteButton.dataset.deleteBook);
        return;
      }
      const bookButton = event.target.closest('[data-book]');
      if(bookButton && container.contains(bookButton)){
        event.preventDefault();
        openBook(bookButton.dataset.book);
      }
    });
  }

  async function deleteBook(id){
    if(!isAdmin()){
      window.alert('Tu cuenta no tiene permisos de administrador para eliminar libros.');
      return;
    }
    const book=books.find(item=>item.id===id);
    if(!book){
      window.alert('No se encontró el libro en la biblioteca. Actualiza la página e inténtalo de nuevo.');
      return;
    }
    const size=(book.file_size/1048576).toFixed(1);
    if(!window.confirm(`¿Eliminar "${book.title}"?\\n\\nSe borrará el PDF de Supabase Storage y se liberarán aproximadamente ${size} MB. También se eliminará el progreso de lectura de ambas cuentas. Esta acción no se puede deshacer.`)) return;

    try {
      const {error:storageError}=await supabase.storage.from('books').remove([book.storage_path]);
      if(storageError){
        console.error('Error eliminando PDF:',storageError);
        window.alert(`Supabase no permitió eliminar el PDF: ${storageError.message}`);
        return;
      }
      const {error:dbError}=await supabase.from('books').delete().eq('id',id);
      if(dbError){
        console.error('Error eliminando registro:',dbError);
        window.alert(`El PDF se eliminó, pero falló el registro del libro: ${dbError.message}`);
        return;
      }
      if(activeBook?.id===id){
        activeBook=null;
        show('readerPage',false);
        navigate('library');
      }
      await loadBooks();
      await renderContinue();
      message('uploadStatus',`Libro eliminado. Se liberaron aproximadamente ${size} MB.`);
    } catch(error) {
      console.error('Fallo inesperado al eliminar libro:',error);
      window.alert(`No se pudo completar la eliminación: ${error.message || error}`);
    }
  }
  function renderBooks(){
    const term=$('searchInput').value.toLowerCase();
    const filtered=books.filter(b=>b.title.toLowerCase().includes(term));
    $('bookGrid').innerHTML=filtered.map(card).join('');
    $('bookCount').textContent=`${books.length} libros`;
    show('emptyState',books.length===0);bindCards($('bookGrid'));
  }
  async function renderContinue(){
    const container=$('continueGrid');
    container.innerHTML='<p class="muted">Cargando tus lecturas…</p>';
    const {data,error}=await supabase.from('reading_progress')
      .select('book_id,progress_percent,updated_at,page_number')
      .eq('user_id',currentUser.id).order('updated_at',{ascending:false});
    if(error){
      console.error('Error al cargar lecturas:',error);
      container.innerHTML='<p class="muted">No se pudieron cargar tus lecturas. Comprueba los permisos de reading_progress.</p>';
      return;
    }
    const rows=(data||[]).filter(r=>Number(r.progress_percent)>0);
    const items=rows.map(r=>books.find(b=>b.id===r.book_id)).filter(Boolean);
    container.innerHTML=items.length ? items.map(card).join('') :
      '<p class="muted">Todavía no tienes lecturas en curso. Abre un libro y tu progreso aparecerá aquí automáticamente.</p>';
    bindCards(container);
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
    $('readerText').innerHTML='';
    show('pdfFallback',false);
    pdfDoc=null;

    try{
      if(!window.pdfjsLib){
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
      }
      if(!window.pdfjsLib){
        showOriginalPdf(url,'No se pudo cargar el lector de PDF.');
        return;
      }

      pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      pdfDoc=await pdfjsLib.getDocument({url,useSystemFonts:true,isEvalSupported:false}).promise;

      let hasText=false;
      for(let n=1;n<=pdfDoc.numPages;n++){
        const page=await pdfDoc.getPage(n);
        const content=await page.getTextContent();
        const items=content.items.filter(item=>item.str && item.str.trim());
        if(items.length) hasText=true;

        const section=document.createElement('section');
        section.dataset.page=n;
        const p=document.createElement('p');
        p.textContent=items.map(item=>item.str.trim()).filter(Boolean).join(' ');
        if(p.textContent.trim()) section.appendChild(p);
        if(section.childElementCount) $('readerText').appendChild(section);
      }

      if(!hasText || !$('readerText').children.length){
        await renderPdfPagesAsCanvas();
        message('readerStatus','Este PDF no contiene texto seleccionable. Se muestra conservando su diseño original.');
      }else{
        message('readerStatus','');
      }

      if(!progressListenerAttached){
        $('readerPage').addEventListener('scroll',saveProgress,{passive:true});
        window.addEventListener('scroll',saveProgress,{passive:true});
        progressListenerAttached=true;
      }
    }catch(e){
      console.error('Error procesando PDF:',e);
      if(pdfDoc){
        try{
          await renderPdfPagesAsCanvas();
          message('readerStatus','No se pudo extraer el texto. Se muestra el documento conservando su diseño original.');
        }catch(renderError){
          console.error('Error mostrando páginas del PDF:',renderError);
          showOriginalPdf(url,'No se pudo procesar este PDF dentro del lector.');
        }
      }else{
        showOriginalPdf(url,'No se pudo procesar este PDF dentro del lector.');
      }
    }
  }

  async function renderPdfPagesAsCanvas(){
    if(!pdfDoc) throw new Error('No hay un PDF cargado.');
    const container=$('readerText');
    container.innerHTML='';
    container.classList.add('pdf-page-view');

    for(let n=1;n<=pdfDoc.numPages;n++){
      const page=await pdfDoc.getPage(n);
      const base=page.getViewport({scale:1});
      const availableWidth=Math.max(280,container.clientWidth-24);
      const scale=Math.min(1.6,availableWidth/base.width);
      const viewport=page.getViewport({scale});
      const section=document.createElement('section');
      section.dataset.page=n;
      section.className='pdf-rendered-page';
      const canvas=document.createElement('canvas');
      const ctx=canvas.getContext('2d',{alpha:false});
      const ratio=Math.min(window.devicePixelRatio||1,1.5);
      canvas.width=Math.floor(viewport.width*ratio);
      canvas.height=Math.floor(viewport.height*ratio);
      canvas.style.width='100%';
      canvas.style.height='auto';
      section.appendChild(canvas);
      container.appendChild(section);
      await page.render({
        canvasContext:ctx,
        viewport,
        transform:ratio===1?null:[ratio,0,0,ratio,0,0]
      }).promise;
    }

    if(!progressListenerAttached){
      $('readerPage').addEventListener('scroll',saveProgress,{passive:true});
      window.addEventListener('scroll',saveProgress,{passive:true});
      progressListenerAttached=true;
    }
  }

  function showOriginalPdf(url,reason){
    $('readerText').innerHTML='';
    const fallback=$('pdfFallback');
    fallback.innerHTML=`
      <p>${escapeHtml(reason)}</p>
      <iframe title="Documento PDF" src="${url}#toolbar=1&navpanes=0" loading="lazy"
        style="display:block;width:100%;height:calc(100dvh - 190px);min-height:65vh;border:0;background:#fff"></iframe>
      <p><a id="openPdf" href="${url}" target="_blank" rel="noopener">Abrir PDF en otra pestaña</a></p>`;
    show('pdfFallback');
  }


  const pdfReaderStyle=document.createElement('style');
  pdfReaderStyle.textContent=`
    .reader-text.pdf-page-view{max-width:100%!important;padding:12px!important}
    .pdf-rendered-page{width:min(100%,900px);margin:0 auto 22px;background:#fff;overflow:hidden;box-shadow:0 3px 18px rgba(40,25,35,.12)}
    .pdf-rendered-page canvas{display:block;width:100%;height:auto}
    #pdfFallback iframe{max-width:100%;background:#fff}
    @media(max-width:760px){
      .reader-text.pdf-page-view{padding:6px!important}
      .pdf-rendered-page{width:100%;margin:0 auto 12px;box-shadow:none}
      #pdfFallback iframe{height:calc(100dvh - 145px)!important;min-height:75vh!important}
    }`;
  document.head.appendChild(pdfReaderStyle);

  function loadScript(src){return new Promise(resolve=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=resolve;document.head.append(s);});}
  async function restoreProgress(){
    const {data}=await supabase.from('reading_progress').select('page_number').eq('user_id',currentUser.id).eq('book_id',activeBook.id).maybeSingle();
    if(data?.page_number){
      const el=$('readerText').querySelector(`[data-page="${data.page_number}"]`);
      if(el){
        const reader=$('readerPage');
        if(window.matchMedia('(max-width: 760px)').matches) reader.scrollTo({top:el.offsetTop-reader.offsetTop-58,behavior:'auto'});
        else el.scrollIntoView({behavior:'auto',block:'start'});
      }
    } else { saveProgress(); }
  }
  function saveProgress(){
    if(!activeBook || !pdfDoc || !currentUser) return;
    clearTimeout(progressTimer);
    progressTimer=setTimeout(async()=>{
      const reader=$('readerPage');
      const sections=[...$('readerText').querySelectorAll('[data-page]')];
      if(!sections.length) return;
      const mobile=window.matchMedia('(max-width: 760px)').matches;
      const edge=mobile ? reader.getBoundingClientRect().top+58 : 95;
      const current=sections.find(section=>section.getBoundingClientRect().bottom>edge) || sections[sections.length-1];
      const pageNumber=Number(current.dataset.page);
      const percent=Math.min(100,Math.max(0,Math.round((pageNumber/pdfDoc.numPages)*10000)/100));
      const {error}=await supabase.from('reading_progress').upsert({
        user_id:currentUser.id,book_id:activeBook.id,page_number:pageNumber,
        progress_percent:percent,updated_at:new Date().toISOString()
      },{onConflict:'user_id,book_id'});
      if(error) console.error('No se pudo guardar el progreso:',error);
    },650);
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
