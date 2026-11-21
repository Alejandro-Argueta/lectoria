# Lectoria · GitHub Pages + Supabase

Versión estática inicial adaptada para dos cuentas privadas:
- Administradora: sube y elimina PDF.
- Lectora: consulta y lee libros.
- Ambas tienen progreso individual.
- No existe registro público desde la web.

## 1. Configurar Supabase
1. Crea un proyecto gratuito en https://supabase.com/.
2. En Authentication > Providers > Email, deja habilitado Email/Password.
3. Desactiva el registro público (Disable signups).
4. Crea manualmente las dos cuentas en Authentication > Users.
5. Copia los UUID de ambas cuentas.
6. Ejecuta `supabase/schema.sql` en SQL Editor, después completa los INSERT de perfiles con los UUID y nombres reales.
7. En Project Settings > API copia Project URL y la publishable/anon key.

## 2. Configurar el frontend
1. Copia `assets/js/config.example.js` como `assets/js/config.js`.
2. Completa `supabaseUrl` y `supabaseAnonKey`.
3. No pongas nunca la service_role key en el navegador.
4. Prueba localmente mediante un servidor estático, no abriendo index.html como file://.

## 3. Publicar en GitHub Pages
1. Crea un repositorio privado en GitHub (Pages puede requerir plan de pago para repositorios privados, según el tipo de cuenta; para evitarlo usa un repositorio público sin secretos).
2. Sube el contenido de esta carpeta a la raíz.
3. En Settings > Pages selecciona Deploy from a branch, branch `main`, folder `/root`.
4. Si usas repositorio público, recuerda que todo el código del frontend será visible. Esto es normal; la seguridad reside en Supabase RLS.
5. Añade el dominio publicado a Supabase Authentication > URL Configuration > Site URL y Redirect URLs.

## 4. Seguridad
- La app no ofrece formulario de registro.
- Supabase Auth solo permite entrar a cuentas creadas por la administradora.
- RLS limita metadatos, archivos y progreso.
- El bucket `books` es privado.
- Los PDF se leen mediante URL firmada temporal.
- Nunca publiques la `service_role` key.
- Los archivos PDF no se suben al repositorio GitHub.

## 5. Limitaciones de esta entrega
- El frontend usa Supabase JS desde CDN y PDF.js desde CDN; se requiere Internet.
- El lector extrae texto por página; el orden de PDFs con columnas puede ser imperfecto.
- Los PDF escaneados requieren OCR, todavía no incluido.
- La extracción actual no conserva necesariamente el diseño original ni detecta capítulos.
- La persistencia de progreso se implementa por página y por usuario.
- El control de roles y acceso debe validarse en Supabase antes de publicar.
- El esquema SQL está preparado para las dos cuentas, pero hay que completar los UUID reales.
