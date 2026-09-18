// =====================================================================
//  HVAC 360° · Pruebas de las reglas de seguridad · VERSIÓN PLAN GRATUITO
//
//  Diferencia con la versión anterior: los usuarios de prueba ya no
//  traen rol en el token. El rol vive en /tenants/{t}/members/{uid},
//  que es lo que se siembra en beforeEach.
//
//  Ejecutar:  npm test   (requiere Java 21 y Node 22+)
// =====================================================================
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, getDocs,
  serverTimestamp, writeBatch, Timestamp,
} from 'firebase/firestore';

let env;
const A = 'empresa-a';
const B = 'empresa-b';

// ---------- Usuarios de prueba (sin claims: el rol está en Firestore) ----------
const as = (uid) => env.authenticatedContext(uid).firestore();
const adminA   = () => as('u-admin-a');
const coordA   = () => as('u-coord-a');
const tecA1    = () => as('u-tec-a1');
const tecA2    = () => as('u-tec-a2');
const clienteA = () => as('u-cli-a');
const adminB   = () => as('u-admin-b');
const nadie    = () => as('u-sin-empresa');   // autenticado, pero sin ficha en ninguna empresa
const anonimo  = () => env.unauthenticatedContext().firestore();

const now = Timestamp.now();
const stamp = (uid) => ({ createdAt: serverTimestamp(), createdBy: uid, updatedAt: serverTimestamp(), updatedBy: uid });
const upd = (uid) => ({ updatedAt: serverTimestamp(), updatedBy: uid });
const oldStamp = { createdAt: now, createdBy: 'seed', updatedAt: now, updatedBy: 'seed' };

const miembro = (name, role, extra = {}) => ({ name, role, active: true, ...extra, ...oldStamp });

const baseOrder = {
  seq: 1, number: 'OT-0001', clientId: 'cli-1', clientName: 'Hotel Caribe', siteId: 'sede-1', siteName: 'Principal',
  assetId: 'eq-1', assetCode: 'AC-00001', type: 'preventivo', priority: 'normal',
  techId: 'tec-1', techUid: 'u-tec-a1', techName: 'Carlos Pérez',
  scheduledDate: '2026-09-20', scheduledTime: '08:00', description: 'Preventivo', status: 'programada',
};

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-hvac360',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
after(async () => { await env.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, `tenants/${A}`), { name: 'Empresa A', status: 'activo', plan: 'profesional' });
    await setDoc(doc(db, `tenants/${B}`), { name: 'Empresa B', status: 'activo', plan: 'basico' });

    // Fichas de miembro: aquí es donde vive el rol
    await setDoc(doc(db, `tenants/${A}/members/u-admin-a`), miembro('Ana Admin', 'admin'));
    await setDoc(doc(db, `tenants/${A}/members/u-coord-a`), miembro('Coco Coord', 'coordinador'));
    await setDoc(doc(db, `tenants/${A}/members/u-tec-a1`),  miembro('Carlos Pérez', 'tecnico'));
    await setDoc(doc(db, `tenants/${A}/members/u-tec-a2`),  miembro('Tito Técnico', 'tecnico'));
    await setDoc(doc(db, `tenants/${A}/members/u-cli-a`),   miembro('Hotel Caribe', 'cliente', { clientId: 'cli-1' }));
    await setDoc(doc(db, `tenants/${B}/members/u-admin-b`), miembro('Beto Admin', 'admin'));

    await setDoc(doc(db, `tenants/${A}/counters/workOrders`), { value: 1 });
    await setDoc(doc(db, `tenants/${A}/clients/cli-1`), { name: 'Hotel Caribe', status: 'activo', ...oldStamp });
    await setDoc(doc(db, `tenants/${A}/clients/cli-2`), { name: 'Clínica Norte', status: 'activo', ...oldStamp });
    await setDoc(doc(db, `tenants/${A}/sites/sede-1`), { clientId: 'cli-1', name: 'Principal', active: true, ...oldStamp });
    await setDoc(doc(db, `tenants/${A}/sites/sede-2`), { clientId: 'cli-2', name: 'Norte', active: true, ...oldStamp });
    await setDoc(doc(db, `tenants/${A}/workOrders/ot-1`), { ...baseOrder, ...oldStamp });
    await setDoc(doc(db, `tenants/${A}/workOrders/ot-2`), { ...baseOrder, seq: 2, number: 'OT-0002', clientId: 'cli-2', clientName: 'Clínica Norte', siteId: 'sede-2', techUid: 'u-tec-a2', techId: 'tec-2', ...oldStamp });
    await setDoc(doc(db, `tenants/${B}/clients/cli-x`), { name: 'Cliente de B', status: 'activo', ...oldStamp });
  });
});

// ---------------------------------------------------------------------
//  1. Aislamiento entre empresas
// ---------------------------------------------------------------------
test('un usuario sin sesión no lee nada', async () => {
  await assertFails(getDoc(doc(anonimo(), `tenants/${A}/clients/cli-1`)));
});
test('un usuario sin ficha de miembro no lee nada', async () => {
  await assertFails(getDoc(doc(nadie(), `tenants/${A}/clients/cli-1`)));
});
test('la empresa A NO puede leer clientes de la empresa B', async () => {
  await assertFails(getDoc(doc(adminA(), `tenants/${B}/clients/cli-x`)));
});
test('la empresa A NO puede escribir en la empresa B', async () => {
  await assertFails(setDoc(doc(adminA(), `tenants/${B}/clients/nuevo`), { name: 'Intruso', status: 'activo', ...stamp('u-admin-a') }));
});
test('el admin de B lee sus propios clientes', async () => {
  await assertSucceeds(getDoc(doc(adminB(), `tenants/${B}/clients/cli-x`)));
});

// ---------------------------------------------------------------------
//  2. Roles y miembros  (lo que antes hacía Cloud Functions)
// ---------------------------------------------------------------------
test('nadie puede ascenderse a sí mismo', async () => {
  await assertFails(updateDoc(doc(tecA1(), `tenants/${A}/members/u-tec-a1`), { role: 'admin', ...upd('u-tec-a1') }));
});
test('el admin tampoco puede editar su propia ficha', async () => {
  await assertFails(updateDoc(doc(adminA(), `tenants/${A}/members/u-admin-a`), { active: false, ...upd('u-admin-a') }));
});
test('el coordinador NO puede cambiar roles', async () => {
  await assertFails(updateDoc(doc(coordA(), `tenants/${A}/members/u-tec-a1`), { role: 'coordinador', ...upd('u-coord-a') }));
});
test('el admin SÍ puede cambiar el rol de otra persona', async () => {
  await assertSucceeds(updateDoc(doc(adminA(), `tenants/${A}/members/u-tec-a1`), { role: 'coordinador', ...upd('u-admin-a') }));
});
test('el admin SÍ puede desactivar a otra persona', async () => {
  await assertSucceeds(updateDoc(doc(adminA(), `tenants/${A}/members/u-tec-a2`), { active: false, ...upd('u-admin-a') }));
});
test('un miembro desactivado pierde el acceso', async () => {
  await env.withSecurityRulesDisabled(async (ctx) =>
    updateDoc(doc(ctx.firestore(), `tenants/${A}/members/u-coord-a`), { active: false }));
  await assertFails(getDoc(doc(coordA(), `tenants/${A}/clients/cli-1`)));
});
test('un usuario del portal de cliente DEBE traer clientId', async () => {
  await assertFails(setDoc(doc(adminA(), `tenants/${A}/members/u-nuevo`),
    { name: 'Cliente sin amarre', role: 'cliente', active: true, ...stamp('u-admin-a') }));
  await assertSucceeds(setDoc(doc(adminA(), `tenants/${A}/members/u-nuevo`),
    { name: 'Cliente OK', role: 'cliente', active: true, clientId: 'cli-2', ...stamp('u-admin-a') }));
});
test('un rol inventado es rechazado', async () => {
  await assertFails(setDoc(doc(adminA(), `tenants/${A}/members/u-nuevo`),
    { name: 'Superusuario', role: 'superadmin', active: true, ...stamp('u-admin-a') }));
});
test('un extraño NO puede meterse a una empresa existente', async () => {
  await assertFails(setDoc(doc(nadie(), `tenants/${A}/members/u-sin-empresa`),
    { name: 'Colado', role: 'admin', active: true, ...stamp('u-sin-empresa') }));
});

// ---------------------------------------------------------------------
//  3. Registro de una empresa nueva  (antes: función registrarEmpresa)
// ---------------------------------------------------------------------
test('alguien nuevo puede registrar su empresa y queda como admin', async () => {
  const db = nadie();
  const batch = writeBatch(db);
  batch.set(doc(db, 'tenants/empresa-nueva'), {
    name: 'Aires del Caribe', status: 'prueba', plan: 'basico',
    createdBy: 'u-sin-empresa', createdAt: serverTimestamp(),
  });
  batch.set(doc(db, 'tenants/empresa-nueva/members/u-sin-empresa'), {
    name: 'Dueño Nuevo', role: 'admin', active: true, ...stamp('u-sin-empresa'),
  });
  await assertSucceeds(batch.commit());
});
test('no se puede registrar una empresa sin quedar de admin', async () => {
  const db = nadie();
  const batch = writeBatch(db);
  batch.set(doc(db, 'tenants/empresa-mala'), {
    name: 'Trampa', status: 'prueba', createdBy: 'u-sin-empresa', createdAt: serverTimestamp(),
  });
  batch.set(doc(db, 'tenants/empresa-mala/members/u-sin-empresa'), {
    name: 'Dueño', role: 'tecnico', active: true, ...stamp('u-sin-empresa'),
  });
  await assertFails(batch.commit());
});
test('una empresa nueva no puede nacer ya activa', async () => {
  const db = nadie();
  const batch = writeBatch(db);
  batch.set(doc(db, 'tenants/empresa-viva'), {
    name: 'Cuenta Gratis', status: 'activo', createdBy: 'u-sin-empresa', createdAt: serverTimestamp(),
  });
  batch.set(doc(db, 'tenants/empresa-viva/members/u-sin-empresa'), {
    name: 'Vivo', role: 'admin', active: true, ...stamp('u-sin-empresa'),
  });
  await assertFails(batch.commit());
});
test('el admin no puede cambiar el plan ni el estado de su empresa', async () => {
  // Ascenderse de plan
  await assertFails(updateDoc(doc(adminA(), `tenants/${A}`), { plan: 'empresarial', ...upd('u-admin-a') }));
  // Pasarse de "prueba" a "activo" sería regalarse la suscripción paga
  await env.withSecurityRulesDisabled(async (ctx) =>
    updateDoc(doc(ctx.firestore(), `tenants/${A}`), { status: 'prueba' }));
  await assertFails(updateDoc(doc(adminA(), `tenants/${A}`), { status: 'activo', ...upd('u-admin-a') }));
  // Y tampoco suspenderse a sí mismo para esquivar algún control
  await assertFails(updateDoc(doc(adminA(), `tenants/${A}`), { status: 'suspendido', ...upd('u-admin-a') }));
});
test('el admin sí puede cambiar el nombre de su empresa', async () => {
  await assertSucceeds(updateDoc(doc(adminA(), `tenants/${A}`), { name: 'Empresa A S.A.S.', ...upd('u-admin-a') }));
});

// ---------------------------------------------------------------------
//  4. Clientes, sedes y equipos
// ---------------------------------------------------------------------
test('coordinador crea un cliente válido', async () => {
  await assertSucceeds(setDoc(doc(coordA(), `tenants/${A}/clients/cli-3`), { name: 'Restaurante 21', status: 'activo', ...stamp('u-coord-a') }));
});
test('no se puede crear un cliente sin nombre', async () => {
  await assertFails(setDoc(doc(coordA(), `tenants/${A}/clients/cli-3`), { name: '', status: 'activo', ...stamp('u-coord-a') }));
});
test('no se aceptan campos extraños en un cliente', async () => {
  await assertFails(setDoc(doc(coordA(), `tenants/${A}/clients/cli-3`), { name: 'X Corp', status: 'activo', hack: true, ...stamp('u-coord-a') }));
});
test('el técnico NO puede crear clientes', async () => {
  await assertFails(setDoc(doc(tecA1(), `tenants/${A}/clients/cli-3`), { name: 'Restaurante 21', status: 'activo', ...stamp('u-tec-a1') }));
});
test('nadie puede borrar un cliente desde la app', async () => {
  await assertFails(deleteDoc(doc(adminA(), `tenants/${A}/clients/cli-1`)));
});
test('no se puede crear una sede para un cliente inexistente', async () => {
  await assertFails(setDoc(doc(coordA(), `tenants/${A}/sites/sede-9`), { clientId: 'no-existe', name: 'Fantasma', active: true, ...stamp('u-coord-a') }));
});
test('el equipo debe pertenecer a una sede del mismo cliente', async () => {
  const db = coordA();
  const eq = { code: 'AC-00002', type: 'Mini Split', brand: 'LG', status: 'operativo', btu: 12000, ...stamp('u-coord-a') };
  await assertSucceeds(setDoc(doc(db, `tenants/${A}/assets/eq-2`), { ...eq, clientId: 'cli-1', siteId: 'sede-1' }));
  await assertFails(setDoc(doc(db, `tenants/${A}/assets/eq-3`), { ...eq, code: 'AC-00003', clientId: 'cli-1', siteId: 'sede-2' }));
});

// ---------------------------------------------------------------------
//  5. Empresa suspendida
// ---------------------------------------------------------------------
test('empresa suspendida: puede leer pero no escribir', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => updateDoc(doc(ctx.firestore(), `tenants/${A}`), { status: 'suspendido' }));
  await assertSucceeds(getDoc(doc(coordA(), `tenants/${A}/clients/cli-1`)));
  await assertFails(setDoc(doc(coordA(), `tenants/${A}/clients/cli-3`), { name: 'Nuevo', status: 'activo', ...stamp('u-coord-a') }));
});

// ---------------------------------------------------------------------
//  6. Órdenes de trabajo
// ---------------------------------------------------------------------
test('crear orden consumiendo el consecutivo en la misma operación', async () => {
  const db = coordA();
  const batch = writeBatch(db);
  batch.update(doc(db, `tenants/${A}/counters/workOrders`), { value: 2 });
  batch.set(doc(db, `tenants/${A}/workOrders/ot-nueva`), { ...baseOrder, seq: 2, number: 'OT-0002', ...stamp('u-coord-a') });
  await assertSucceeds(batch.commit());
});
test('crear orden SIN actualizar el consecutivo es rechazado', async () => {
  await assertFails(setDoc(doc(coordA(), `tenants/${A}/workOrders/ot-nueva`), { ...baseOrder, seq: 2, number: 'OT-0002', ...stamp('u-coord-a') }));
});
test('el consecutivo solo puede subir de 1 en 1', async () => {
  await assertFails(updateDoc(doc(coordA(), `tenants/${A}/counters/workOrders`), { value: 50 }));
});
test('orden correctiva sin equipo es rechazada', async () => {
  const db = coordA();
  const batch = writeBatch(db);
  batch.update(doc(db, `tenants/${A}/counters/workOrders`), { value: 2 });
  batch.set(doc(db, `tenants/${A}/workOrders/ot-nueva`), { ...baseOrder, seq: 2, number: 'OT-0002', type: 'correctivo', assetId: null, ...stamp('u-coord-a') });
  await assertFails(batch.commit());
});
test('orden "programada" sin técnico es rechazada', async () => {
  const db = coordA();
  const batch = writeBatch(db);
  batch.update(doc(db, `tenants/${A}/counters/workOrders`), { value: 2 });
  batch.set(doc(db, `tenants/${A}/workOrders/ot-nueva`), { ...baseOrder, seq: 2, number: 'OT-0002', techId: null, techUid: null, ...stamp('u-coord-a') });
  await assertFails(batch.commit());
});

test('el técnico solo ve SUS órdenes', async () => {
  await assertSucceeds(getDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-1`)));
  await assertFails(getDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-2`)));
  await assertSucceeds(getDocs(query(collection(tecA1(), `tenants/${A}/workOrders`), where('techUid', '==', 'u-tec-a1'))));
  await assertFails(getDocs(collection(tecA1(), `tenants/${A}/workOrders`)));
});
test('el técnico avanza su orden: programada → en ruta', async () => {
  await assertSucceeds(updateDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-1`), { status: 'en_ruta', ...upd('u-tec-a1') }));
});
test('el técnico NO puede saltar de programada a completada', async () => {
  await assertFails(updateDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-1`), { status: 'completada', ...upd('u-tec-a1') }));
});
test('el técnico NO puede cambiar la prioridad ni reasignar', async () => {
  await assertFails(updateDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-1`), { priority: 'critica', ...upd('u-tec-a1') }));
});
test('el técnico NO puede tocar órdenes de otro técnico', async () => {
  await assertFails(updateDoc(doc(tecA2(), `tenants/${A}/workOrders/ot-1`), { status: 'en_ruta', ...upd('u-tec-a2') }));
});
test('cancelar exige un motivo', async () => {
  const ref = doc(coordA(), `tenants/${A}/workOrders/ot-1`);
  await assertFails(updateDoc(ref, { status: 'cancelada', ...upd('u-coord-a') }));
  await assertSucceeds(updateDoc(ref, { status: 'cancelada', statusNote: 'Cliente reprogramó', ...upd('u-coord-a') }));
});
test('una orden completada ya no se puede modificar', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => updateDoc(doc(ctx.firestore(), `tenants/${A}/workOrders/ot-1`), { status: 'completada' }));
  await assertFails(updateDoc(doc(coordA(), `tenants/${A}/workOrders/ot-1`), { description: 'cambio', ...upd('u-coord-a') }));
});
test('la fecha de creación no se puede alterar', async () => {
  await assertFails(updateDoc(doc(coordA(), `tenants/${A}/workOrders/ot-1`), { createdBy: 'otro', ...upd('u-coord-a') }));
});

// ---------------------------------------------------------------------
//  7. Portal del cliente
// ---------------------------------------------------------------------
test('el cliente ve sus órdenes y NO las de otros clientes', async () => {
  await assertSucceeds(getDoc(doc(clienteA(), `tenants/${A}/workOrders/ot-1`)));
  await assertFails(getDoc(doc(clienteA(), `tenants/${A}/workOrders/ot-2`)));
  await assertSucceeds(getDoc(doc(clienteA(), `tenants/${A}/clients/cli-1`)));
  await assertFails(getDoc(doc(clienteA(), `tenants/${A}/clients/cli-2`)));
});
test('el cliente NO puede modificar órdenes', async () => {
  await assertFails(updateDoc(doc(clienteA(), `tenants/${A}/workOrders/ot-1`), { priority: 'critica', ...upd('u-cli-a') }));
});

// ---------------------------------------------------------------------
//  8. Historial y bitácora inmutables
// ---------------------------------------------------------------------
test('el historial se puede agregar pero no editar ni borrar', async () => {
  const db = tecA1();
  const ref = doc(db, `tenants/${A}/workOrders/ot-1/events/e1`);
  await assertSucceeds(setDoc(ref, { type: 'cambio_estado', status: 'en_ruta', note: 'Saliendo', by: 'u-tec-a1', byName: 'Carlos', at: serverTimestamp() }));
  await assertFails(updateDoc(ref, { note: 'editado' }));
  await assertFails(setDoc(doc(db, `tenants/${A}/workOrders/ot-1/events/e2`), { type: 'nota', by: 'otro-usuario', at: serverTimestamp() }));
});
test('la bitácora se escribe una vez y no se edita', async () => {
  const db = adminA();
  const ref = doc(db, `tenants/${A}/auditLog/a1`);
  await assertSucceeds(setDoc(ref, { accion: 'cambio_rol', by: 'u-admin-a', at: serverTimestamp() }));
  await assertFails(updateDoc(ref, { accion: 'otra cosa' }));
  await assertFails(deleteDoc(ref));
});
test('el técnico no lee la bitácora', async () => {
  await assertFails(getDoc(doc(tecA1(), `tenants/${A}/auditLog/a1`)));
});
