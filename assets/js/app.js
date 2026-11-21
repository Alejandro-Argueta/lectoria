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
    if(isAdmin() && $('storageAdminPanel')) await renderStorageAdmin();
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
      window.alert('No se encontró el libro. Actualiza la página e inténtalo de nuevo.');
      return;
    }
    const size=(Number(book.file_size||0)/1048576).toFixed(1);
    if(!window.confirm(`¿Eliminar "${book.title}"?\\n\\nSe eliminará el PDF de Storage, el registro del libro y el progreso de lectura de ambas cuentas. Se liberarán aproximadamente ${size} MB.`)) return;

    const buttons=[...document.querySelectorAll(`[data-delete-book="${CSS.escape(id)}"]`)];
    buttons.forEach(button=>{button.disabled=true;button.textContent='…';});
    try{
      const {data,error}=await supabase.functions.invoke('lectoria-admin',{
        body:{action:'delete_book',bookId:id}
      });
      if(error) throw error;
      if(!data?.ok) throw new Error(data?.error || 'No se pudo eliminar el libro.');
      if(activeBook?.id===id){
        activeBook=null;
        show('readerPage',false);
        navigate('library');
      }
      await loadBooks();
      await renderContinue();
      if(isAdmin()) await renderStorageAdmin();
      window.alert(data.storageRemoved===false
        ? 'El registro se eliminó, pero el PDF quedó pendiente de limpieza. Usa «Limpiar archivos huérfanos».'
        : `Libro eliminado. Se liberaron aproximadamente ${size} MB.`);
    }catch(error){
      console.error('Error eliminando libro:',error);
      window.alert(`No se pudo eliminar el libro: ${error.message || error}`);
      buttons.forEach(button=>{button.disabled=false;button.textContent='×';});
    }
  }

  async function renderStorageAdmin(){
    const panel=$('storageAdminPanel');
    if(!panel || !isAdmin()) return;
    panel.classList.remove('hidden');
    const status=$('storageAdminStatus');
    status.textContent='Consultando almacenamiento…';
    $('cleanupOrphansBtn').disabled=true;
    try{
      const {data,error}=await supabase.functions.invoke('lectoria-admin',{
        body:{action:'storage_summary'}
      });
      if(error) throw error;
      if(!data?.ok) throw new Error(data?.error || 'No se pudo consultar Storage.');
      const mb=(Number(data.usedBytes||0)/1048576);
      const quota=1024;
      const pct=Math.min(100,mb/quota*100);
      $('storageUsed').textContent=`${mb.toFixed(2)} MB`;
      $('storageFiles').textContent=String(data.fileCount||0);
      $('storageOrphans').textContent=String((data.orphans||[]).length);
      $('storageProgress').style.width=`${pct}%`;
      $('storageOrphanList').innerHTML=(data.orphans||[]).length
        ? data.orphans.map(file=>`<li>${escapeHtml(file.name.split('/').pop())} <span>${(Number(file.size||0)/1048576).toFixed(2)} MB</span></li>`).join('')
        : '<li class="storage-clean">No hay archivos huérfanos.</li>';
      status.textContent='El consumo mostrado corresponde al bucket books. La cuota total de la organización puede incluir otros proyectos.';
      $('cleanupOrphansBtn').disabled=!(data.orphans||[]).length;
    }catch(error){
      console.error('Error consultando almacenamiento:',error);
      status.textContent=`No se pudo consultar Storage: ${error.message || error}. Verifica que la Edge Function lectoria-admin esté desplegada.`;
      $('storageUsed').textContent='—';
      $('storageFiles').textContent='—';
      $('storageOrphans').textContent='—';
      $('storageOrphanList').innerHTML='';
    }
  }

  $('refreshStorageBtn').addEventListener('click',renderStorageAdmin);
  $('cleanupOrphansBtn').addEventListener('click',async()=>{
    if(!isAdmin()) return;
    const count=Number($('storageOrphans').textContent)||0;
    if(!count) return;
    if(!window.confirm(`Se encontraron ${count} PDF sin registro en la biblioteca.\\n\\nSe eliminarán únicamente esos archivos huérfanos del bucket books. Los libros registrados no se tocarán. ¿Continuar?`)) return;
    $('cleanupOrphansBtn').disabled=true;
    $('storageAdminStatus').textContent='Eliminando archivos huérfanos…';
    try{
      const {data,error}=await supabase.functions.invoke('lectoria-admin',{
        body:{action:'cleanup_orphans'}
      });
      if(error) throw error;
      if(!data?.ok) throw new Error(data?.error || 'No se pudieron limpiar los archivos.');
      await renderStorageAdmin();
      window.alert(`Limpieza terminada. Archivos eliminados: ${data.deletedCount||0}. Espacio recuperado: ${(Number(data.deletedBytes||0)/1048576).toFixed(2)} MB.`);
    }catch(error){
      console.error('Error limpiando Storage:',error);
      $('storageAdminStatus').textContent=`No se pudo completar la limpieza: ${error.message || error}`;
      $('cleanupOrphansBtn').disabled=false;
    }
  });

  function renderBooks(){
    const term=$('searchInput').value.toLowerCase();
    const filtered=books.filter(b=>b.title.toLowerCase().includes(term));
    $('bookGrid').innerHTML=filtered.map(card).join('');
    $('bookCount').textContent=`${books.length} libros`;
    show('emptyState',books.length===0);bindCards($('bookGrid'));
  }
  async function renderContinue(){
    const container=$('continueGrid');
    container.innerHTML='<p class="continue-message muted">Cargando tus lecturas…</p>';

    const {data,error}=await supabase.from('reading_progress')
      .select('book_id,progress_percent,updated_at,page_number')
      .eq('user_id',currentUser.id)
      .gt('progress_percent',0)
      .order('updated_at',{ascending:false});

    if(error){
      console.error('Error al cargar reading_progress:',error);
      container.innerHTML=`
        <div class="continue-message continue-error">
          <strong>No se pudieron cargar tus lecturas</strong>
          <p>${escapeHtml(error.message || 'Error desconocido de Supabase')}</p>
          <small>Revisa los permisos de lectura de la tabla reading_progress.</small>
        </div>`;
      return;
    }

    const rows=data||[];
    const items=rows
      .map(row=>({book:books.find(book=>book.id===row.book_id),progress:row}))
      .filter(item=>item.book);

    if(!items.length){
      container.innerHTML=`
        <div class="continue-message continue-empty">
          <strong>Todavía no tienes lecturas en curso</strong>
          <p>Abre un libro y empieza a leer. Lectoria guardará tu avance automáticamente.</p>
        </div>`;
      return;
    }

    container.innerHTML=items.map(({book,progress})=>`
      <div class="continue-card">
        ${card(book)}
        <div class="continue-progress">
          <div class="continue-progress-label">
            <span>Página ${Number(progress.page_number)||1}</span>
            <span>${Math.round(Number(progress.progress_percent)||0)}%</span>
          </div>
          <div class="continue-progress-track">
            <span style="width:${Math.min(100,Math.max(0,Number(progress.progress_percent)||0))}%"></span>
          </div>
        </div>
      </div>`).join('');
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
    if(!window.pdfjsLib){
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
    }

    if(!window.pdfjsLib){
      show('pdfFallback');
      $('openPdf').href=url;
      message('readerStatus','No se pudo cargar PDF.js.');
      return;
    }

    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    try{
      pdfDoc=await pdfjsLib.getDocument(url).promise;
      $('readerText').innerHTML='';

      const extractedPages=[];
      const repeatedEdgeLines=new Map();

      // Extraer texto conservando las coordenadas originales del PDF.
      for(let n=1;n<=pdfDoc.numPages;n++){
        const page=await pdfDoc.getPage(n);
        const viewport=page.getViewport({scale:1});
        const content=await page.getTextContent();

        const items=content.items
          .filter(item=>item.str && item.str.trim())
          .map(item=>({
            text:item.str.trim(),
            x:item.transform[4],
            y:item.transform[5],
            width:item.width || 0,
            height:Math.abs(item.transform[3]) || item.height || 10
          }));

        // Agrupar fragmentos por línea usando su posición vertical.
        items.sort((a,b)=>{
          if(Math.abs(b.y-a.y)>2.5) return b.y-a.y;
          return a.x-b.x;
        });

        const lines=[];
        for(const item of items){
          let line=lines.find(candidate=>
            Math.abs(candidate.y-item.y)<=Math.max(2.5,item.height*0.3)
          );

          if(!line){
            line={y:item.y,height:item.height,items:[]};
            lines.push(line);
          }

          line.items.push(item);
          line.height=Math.max(line.height,item.height);
        }

        for(const line of lines){
          line.items.sort((a,b)=>a.x-b.x);
          let value='';
          let previous=null;

          for(const item of line.items){
            if(previous){
              const gap=item.x-(previous.x+previous.width);
              // Insertar espacio solo cuando existe separación física entre palabras.
              if(gap>Math.max(1.2,item.height*0.12)) value+=' ';
            }
            value+=item.text;
            previous=item;
          }

          line.text=value.replace(/\s+/g,' ').trim();
        }

        lines.sort((a,b)=>b.y-a.y);

        // Detectar líneas repetidas en los márgenes superior e inferior.
        const nonEmpty=lines.filter(line=>line.text);
        nonEmpty.forEach((line,index)=>{
          if(index<2 || index>=nonEmpty.length-2){
            const key=normalizePdfLine(line.text);
            if(key.length>3){
              repeatedEdgeLines.set(key,(repeatedEdgeLines.get(key)||0)+1);
            }
          }
        });

        extractedPages.push({
          number:n,
          height:viewport.height,
          lines:nonEmpty
        });
      }

      // Convertir las líneas en párrafos legibles.
      for(const pageData of extractedPages){
        const section=document.createElement('section');
        section.dataset.page=pageData.number;

        const lines=pageData.lines.filter((line,index,array)=>{
          const value=line.text.trim();
          const key=normalizePdfLine(value);
          const edge=index<2 || index>=array.length-2;

          // Eliminar números de página aislados y URLs/editoriales repetitivas.
          if(/^(p[aá]gina\s*)?\d{1,4}$/i.test(value)) return false;
          if(/^(https?:\/\/|www\.)/i.test(value)) return false;
          if(edge && key.length>3 && (repeatedEdgeLines.get(key)||0)>=2) return false;

          return true;
        });

        const gaps=[];
        for(let i=1;i<lines.length;i++){
          const gap=lines[i-1].y-lines[i].y;
          if(gap>0) gaps.push(gap);
        }

        const orderedGaps=[...gaps].sort((a,b)=>a-b);
        const typicalGap=orderedGaps.length
          ? orderedGaps[Math.floor(orderedGaps.length*0.5)]
          : 12;

        let paragraph='';
        let previousLine=null;

        const appendParagraph=()=>{
          const value=paragraph.trim();
          if(value){
            const p=document.createElement('p');
            p.textContent=value;
            section.appendChild(p);
          }
          paragraph='';
        };

        for(const line of lines){
          const value=line.text.trim();
          if(!value) continue;

          const verticalGap=previousLine
            ? previousLine.y-line.y
            : 0;

          const isShortHeading=
            value.length<=75 &&
            (
              /^(cap[ií]tulo|pr[oó]logo|ep[ií]logo|introducci[oó]n|parte\s+\w+)/i.test(value) ||
              (/^[A-ZÁÉÍÓÚÜÑ0-9\s:.,¡!¿?()-]+$/.test(value) && value.length>=4)
            );

          const startsNewParagraph=
            previousLine && verticalGap>Math.max(typicalGap*1.55,typicalGap+3);

          if(isShortHeading || startsNewParagraph){
            appendParagraph();
          }

          // Unir palabras cortadas por guion al final de una línea.
          if(paragraph && /[-\u00ad]$/.test(paragraph)){
            paragraph=paragraph.replace(/[-\u00ad]$/,'')+value;
          }else{
            paragraph+=(paragraph?' ':'')+value;
          }

          if(isShortHeading) appendParagraph();
          previousLine=line;
        }

        appendParagraph();

        if(section.childElementCount){
          $('readerText').append(section);
        }
      }

      if(!$('readerText').children.length){
        message('readerStatus','Este PDF no contiene texto seleccionable. Puedes abrir el PDF original.');
        show('pdfFallback');
        $('openPdf').href=url;
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
      show('pdfFallback');
      $('openPdf').href=url;
      message('readerStatus','No se pudo procesar el texto de este PDF.');
    }
  }

  function loadScript(src){return new Promise(resolve=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=resolve;document.head.append(s);});}
  async function restoreProgress(){
    const {data,error}=await supabase.from('reading_progress').select('page_number').eq('user_id',currentUser.id).eq('book_id',activeBook.id).maybeSingle();
    if(error){
      console.error('No se pudo recuperar el progreso:',error);
      message('readerStatus','El libro abrió, pero no se pudo recuperar tu progreso de lectura.');
      return;
    }
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

  window.addEventListener('pagehide',()=>{if(activeBook) saveProgress();});
  $('backLibrary').addEventListener('click',()=>{saveProgress();navigate('library');});

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
