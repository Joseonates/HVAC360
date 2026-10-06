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
test('el admin crea el contador de órdenes en cero, pero no arrancando en otro número', async () => {
  await env.withSecurityRulesDisabled(async (ctx) =>
    deleteDoc(doc(ctx.firestore(), `tenants/${A}/counters/workOrders`)));
  await assertFails(setDoc(doc(adminA(), `tenants/${A}/counters/workOrders`), { value: 100 }));
  await assertSucceeds(setDoc(doc(adminA(), `tenants/${A}/counters/workOrders`), { value: 0 }));
});
test('el coordinador NO puede crear el contador', async () => {
  await env.withSecurityRulesDisabled(async (ctx) =>
    deleteDoc(doc(ctx.firestore(), `tenants/${A}/counters/workOrders`)));
  await assertFails(setDoc(doc(coordA(), `tenants/${A}/counters/workOrders`), { value: 0 }));
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
//  6a. Inventario: bodegas, repuestos y movimientos
// ---------------------------------------------------------------------
const bodega = { name:'Bodega Barranquilla', city:'Barranquilla', active:true };
const repuesto = { code:'CAP-45', name:'Capacitor 45+5 uF', unit:'Und', category:'Eléctrico',
                   cost:38000, price:65000, minStock:4, active:true };
const salida = (uid, extra={}) => ({
  type:'salida', partId:'rep-1', partName:'Capacitor 45+5 uF', warehouseId:'bod-1',
  qty:1, orderId:'ot-1', orderNumber:'OT-0001', status:'pendiente',
  requestedBy:uid, requestedByName:'Carlos', ...extra,
});

test('el coordinador crea bodega y repuesto; el técnico los lee pero no los crea', async () => {
  await assertSucceeds(setDoc(doc(coordA(), `tenants/${A}/warehouses/bod-1`), { ...bodega, ...stamp('u-coord-a') }));
  await assertSucceeds(setDoc(doc(coordA(), `tenants/${A}/parts/rep-1`), { ...repuesto, ...stamp('u-coord-a') }));
  await assertSucceeds(getDoc(doc(tecA1(), `tenants/${A}/parts/rep-1`)));
  await assertFails(setDoc(doc(tecA1(), `tenants/${A}/parts/rep-2`), { ...repuesto, code:'X', ...stamp('u-tec-a1') }));
});
test('un precio negativo es rechazado', async () => {
  await assertFails(setDoc(doc(coordA(), `tenants/${A}/parts/rep-3`), { ...repuesto, price:-1, ...stamp('u-coord-a') }));
});
test('la existencia solo la mueve la oficina', async () => {
  await assertSucceeds(setDoc(doc(coordA(), `tenants/${A}/warehouses/bod-1/stock/rep-1`), { qty:10, ...upd('u-coord-a') }));
  await assertFails(setDoc(doc(tecA1(), `tenants/${A}/warehouses/bod-1/stock/rep-1`), { qty:99, ...upd('u-tec-a1') }));
  await assertSucceeds(getDoc(doc(tecA1(), `tenants/${A}/warehouses/bod-1/stock/rep-1`)));
});
test('la existencia no puede quedar negativa', async () => {
  await assertFails(setDoc(doc(coordA(), `tenants/${A}/warehouses/bod-1/stock/rep-1`), { qty:-3, ...upd('u-coord-a') }));
});
test('el técnico pide la salida de SU orden y queda pendiente', async () => {
  await assertSucceeds(setDoc(doc(tecA1(), `tenants/${A}/movements/mv-1`), { ...salida('u-tec-a1'), ...stamp('u-tec-a1') }));
});
test('el técnico NO pide salidas de la orden de otro', async () => {
  await assertFails(setDoc(doc(tecA2(), `tenants/${A}/movements/mv-2`), { ...salida('u-tec-a2'), ...stamp('u-tec-a2') }));
});
test('el técnico NO puede dejar una salida ya aprobada', async () => {
  await assertFails(setDoc(doc(tecA1(), `tenants/${A}/movements/mv-3`),
    { ...salida('u-tec-a1', { status:'aprobado' }), ...stamp('u-tec-a1') }));
});
test('el técnico NO puede registrar entradas de bodega', async () => {
  await assertFails(setDoc(doc(tecA1(), `tenants/${A}/movements/mv-4`),
    { ...salida('u-tec-a1', { type:'entrada' }), ...stamp('u-tec-a1') }));
});
test('la oficina aprueba la salida; el técnico no', async () => {
  await env.withSecurityRulesDisabled(async (ctx) =>
    setDoc(doc(ctx.firestore(), `tenants/${A}/movements/mv-5`), { ...salida('u-tec-a1'), ...oldStamp }));
  await assertFails(updateDoc(doc(tecA1(), `tenants/${A}/movements/mv-5`), { status:'aprobado', ...upd('u-tec-a1') }));
  await assertSucceeds(updateDoc(doc(coordA(), `tenants/${A}/movements/mv-5`), { status:'aprobado', approvedBy:'u-coord-a', ...upd('u-coord-a') }));
});
test('una salida ya aprobada no se vuelve a tocar', async () => {
  await env.withSecurityRulesDisabled(async (ctx) =>
    setDoc(doc(ctx.firestore(), `tenants/${A}/movements/mv-6`), { ...salida('u-tec-a1'), status:'aprobado', ...oldStamp }));
  await assertFails(updateDoc(doc(coordA(), `tenants/${A}/movements/mv-6`), { status:'rechazado', ...upd('u-coord-a') }));
});
test('al aprobar no se puede cambiar la cantidad ni el repuesto', async () => {
  await env.withSecurityRulesDisabled(async (ctx) =>
    setDoc(doc(ctx.firestore(), `tenants/${A}/movements/mv-7`), { ...salida('u-tec-a1'), ...oldStamp }));
  await assertFails(updateDoc(doc(coordA(), `tenants/${A}/movements/mv-7`), { status:'aprobado', qty:99, ...upd('u-coord-a') }));
  await assertFails(updateDoc(doc(coordA(), `tenants/${A}/movements/mv-7`), { status:'aprobado', partId:'otro', ...upd('u-coord-a') }));
});
test('el cliente del portal no ve el inventario', async () => {
  await env.withSecurityRulesDisabled(async (ctx) =>
    setDoc(doc(ctx.firestore(), `tenants/${A}/parts/rep-1`), { ...repuesto, ...oldStamp }));
  await assertFails(getDoc(doc(clienteA(), `tenants/${A}/parts/rep-1`)));
});

// ---------------------------------------------------------------------
//  6b. Contratos de mantenimiento
// ---------------------------------------------------------------------
const baseContrato = {
  name:'Mantenimiento 2026', clientId:'cli-1', clientName:'Hotel Caribe',
  siteIds:['sede-1'], frequency:'trimestral', mode:'equipo', status:'activo',
  startDate:'2026-01-01',
};
test('coordinador crea un contrato válido', async () => {
  await assertSucceeds(setDoc(doc(coordA(), `tenants/${A}/contracts/ct-1`), { ...baseContrato, ...stamp('u-coord-a') }));
});
test('el técnico NO puede crear contratos, pero sí leerlos', async () => {
  await assertFails(setDoc(doc(tecA1(), `tenants/${A}/contracts/ct-2`), { ...baseContrato, ...stamp('u-tec-a1') }));
  await env.withSecurityRulesDisabled(async (ctx) =>
    setDoc(doc(ctx.firestore(), `tenants/${A}/contracts/ct-1`), { ...baseContrato, ...oldStamp }));
  await assertSucceeds(getDoc(doc(tecA1(), `tenants/${A}/contracts/ct-1`)));
});
test('una frecuencia inventada es rechazada', async () => {
  await assertFails(setDoc(doc(coordA(), `tenants/${A}/contracts/ct-3`), { ...baseContrato, frequency:'quincenal', ...stamp('u-coord-a') }));
});
test('un contrato no puede cambiar de cliente', async () => {
  await env.withSecurityRulesDisabled(async (ctx) =>
    setDoc(doc(ctx.firestore(), `tenants/${A}/contracts/ct-1`), { ...baseContrato, ...oldStamp }));
  await assertFails(updateDoc(doc(coordA(), `tenants/${A}/contracts/ct-1`), { clientId:'cli-2', ...upd('u-coord-a') }));
  await assertSucceeds(updateDoc(doc(coordA(), `tenants/${A}/contracts/ct-1`), { frequency:'semestral', ...upd('u-coord-a') }));
});
test('el cliente del portal ve su contrato y no el de otro', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, `tenants/${A}/contracts/ct-1`), { ...baseContrato, ...oldStamp });
    await setDoc(doc(db, `tenants/${A}/contracts/ct-9`), { ...baseContrato, clientId:'cli-2', ...oldStamp });
  });
  await assertSucceeds(getDoc(doc(clienteA(), `tenants/${A}/contracts/ct-1`)));
  await assertFails(getDoc(doc(clienteA(), `tenants/${A}/contracts/ct-9`)));
});
test('una visita de contrato puede ir sin equipo puntual', async () => {
  const db = coordA();
  const batch = writeBatch(db);
  batch.update(doc(db, `tenants/${A}/counters/workOrders`), { value: 2 });
  batch.set(doc(db, `tenants/${A}/workOrders/ot-visita`),
    { ...baseOrder, seq: 2, number: 'OT-0002', assetId: null, assetCode: null, contractId: 'ct-1', ...stamp('u-coord-a') });
  await assertSucceeds(batch.commit());
});
test('una preventiva suelta sigue exigiendo equipo', async () => {
  const db = coordA();
  const batch = writeBatch(db);
  batch.update(doc(db, `tenants/${A}/counters/workOrders`), { value: 2 });
  batch.set(doc(db, `tenants/${A}/workOrders/ot-sin-eq`),
    { ...baseOrder, seq: 2, number: 'OT-0002', assetId: null, assetCode: null, ...stamp('u-coord-a') });
  await assertFails(batch.commit());
});

test('el admin puede dar acceso al portal a un cliente', async () => {
  await assertSucceeds(updateDoc(doc(adminA(), `tenants/${A}/clients/cli-1`),
    { portalUid: 'u-portal-1', portalEmail: 'contacto@hotelcaribe.com', ...upd('u-admin-a') }));
});
test('un usuario de portal exige estar amarrado a un cliente', async () => {
  await assertFails(setDoc(doc(adminA(), `tenants/${A}/members/u-portal-1`),
    { name: 'Hotel Caribe', role: 'cliente', active: true, ...stamp('u-admin-a') }));
  await assertSucceeds(setDoc(doc(adminA(), `tenants/${A}/members/u-portal-1`),
    { name: 'Hotel Caribe', email: 'contacto@hotelcaribe.com', role: 'cliente', active: true, clientId: 'cli-1', ...stamp('u-admin-a') }));
});
test('el cliente ve sus equipos y sus sedes, no las de otro', async () => {
  await env.withSecurityRulesDisabled(async (ctx) =>
    setDoc(doc(ctx.firestore(), `tenants/${A}/assets/eq-1`),
      { code:'AC-1', clientId:'cli-1', siteId:'sede-1', type:'Mini Split', brand:'LG', status:'operativo', ...oldStamp }));
  await assertSucceeds(getDocs(query(collection(clienteA(), `tenants/${A}/assets`), where('clientId','==','cli-1'))));
  await assertFails(getDocs(query(collection(clienteA(), `tenants/${A}/assets`), where('clientId','==','cli-2'))));
  await assertSucceeds(getDocs(query(collection(clienteA(), `tenants/${A}/sites`), where('clientId','==','cli-1'))));
});
test('el cliente NO puede tocar sus propios equipos', async () => {
  await assertFails(setDoc(doc(clienteA(), `tenants/${A}/assets/eq-2`),
    { code:'AC-2', clientId:'cli-1', siteId:'sede-1', type:'Mini Split', brand:'LG', status:'operativo', ...stamp('u-cli-a') }));
});

// ---------------------------------------------------------------------
//  6c. Registro fotográfico
// ---------------------------------------------------------------------
const fotoBase = (uid, fase='antes') => ({
  fase, thumb: 'data:image/jpeg;base64,' + 'A'.repeat(400),
  by: uid, byName: 'Carlos', at: serverTimestamp(),
});
const fotoGrande = () => ({ data: 'data:image/jpeg;base64,' + 'A'.repeat(5000) });
test('el técnico sube fotos de su orden', async () => {
  await assertSucceeds(setDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-1/photos/f1`), fotoBase('u-tec-a1','antes')));
  await assertSucceeds(setDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-1/photos/f2`), fotoBase('u-tec-a1','despues')));
});
test('el técnico NO sube fotos a la orden de otro', async () => {
  await assertFails(setDoc(doc(tecA2(), `tenants/${A}/workOrders/ot-1/photos/f3`), fotoBase('u-tec-a2')));
});
test('una fase inventada es rechazada', async () => {
  await assertFails(setDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-1/photos/f4`), fotoBase('u-tec-a1','despuesito')));
});
test('una foto no se puede editar', async () => {
  await assertSucceeds(setDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-1/photos/f5`), fotoBase('u-tec-a1')));
  await assertFails(updateDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-1/photos/f5`), { nota: 'otra cosa' }));
});
test('se puede borrar una foto mientras el cliente no firme', async () => {
  await assertSucceeds(setDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-1/photos/f6`), fotoBase('u-tec-a1')));
  await assertSucceeds(deleteDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-1/photos/f6`)));
});
test('firmado el reporte, la foto ya no se borra', async () => {
  await assertSucceeds(setDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-1/photos/f7`), fotoBase('u-tec-a1')));
  await env.withSecurityRulesDisabled(async (ctx) =>
    setDoc(doc(ctx.firestore(), `tenants/${A}/workOrders/ot-1/report/ficha`),
      { tipo:'preventivo', firmaCliente:'data:image/png;base64,AAA', ...oldStamp }));
  await assertFails(deleteDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-1/photos/f7`)));
});
test('la foto grande se guarda aparte y el cliente la puede ver', async () => {
  await assertSucceeds(setDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-1/photoFiles/f10`), fotoGrande()));
  await assertFails(setDoc(doc(tecA2(), `tenants/${A}/workOrders/ot-1/photoFiles/f11`), fotoGrande()));
  await assertSucceeds(getDoc(doc(clienteA(), `tenants/${A}/workOrders/ot-1/photoFiles/f10`)));
});
test('la miniatura no admite la foto grande', async () => {
  await assertFails(setDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-1/photos/f12`),
    { fase:'antes', thumb:'data:image/jpeg;base64,'+'A'.repeat(200000), by:'u-tec-a1', at: serverTimestamp() }));
});
test('el cliente ve las fotos de su servicio y no las de otro', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `tenants/${A}/workOrders/ot-1/photos/f8`), { ...fotoBase('u-tec-a1'), at: now });
    await setDoc(doc(ctx.firestore(), `tenants/${A}/workOrders/ot-2/photos/f9`), { ...fotoBase('u-tec-a2'), at: now });
  });
  await assertSucceeds(getDoc(doc(clienteA(), `tenants/${A}/workOrders/ot-1/photos/f8`)));
  await assertFails(getDoc(doc(clienteA(), `tenants/${A}/workOrders/ot-2/photos/f9`)));
});

// ---------------------------------------------------------------------
//  6d. Evidencia obligatoria cuando se usan repuestos
// ---------------------------------------------------------------------
const sembrarFotos = async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const [id, fase] of [['fa','antes'],['fd','durante'],['fp','despues']]) {
      await setDoc(doc(db, `tenants/${A}/workOrders/ot-1/photos/${id}`),
        { fase, thumb:'data:image/jpeg;base64,'+'A'.repeat(300), by:'u-tec-a1', at: now });
    }
  });
};
const fichaFirmada = (extra={}) => ({
  tipo:'correctivo', firmaCliente:'data:image/png;base64,AAA', firmaClienteNombre:'María Torres',
  materiales:[{descripcion:'Capacitor', unidad:'Und', cantidad:'1', partId:'rep-1'}],
  updatedAt: serverTimestamp(), updatedBy:'u-tec-a1', ...extra,
});

test('sin repuestos, el reporte se firma sin exigir fotos', async () => {
  await assertSucceeds(setDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-1/report/ficha`),
    { ...fichaFirmada({ materiales: [] }) }));
});
test('con repuestos y sin evidencia, el reporte firmado se rechaza', async () => {
  await assertFails(setDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-1/report/ficha`), fichaFirmada()));
});
test('con repuestos y las tres fotos, el reporte firmado pasa', async () => {
  await sembrarFotos();
  await assertSucceeds(setDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-1/report/ficha`),
    fichaFirmada({ evidencia: { antes:'fa', durante:'fd', despues:'fp' } })));
});
test('no vale señalar una foto que no existe', async () => {
  await sembrarFotos();
  await assertFails(setDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-1/report/ficha`),
    fichaFirmada({ evidencia: { antes:'fa', durante:'fd', despues:'inventada' } })));
});
test('no vale pasar la misma foto por las tres fases', async () => {
  await sembrarFotos();
  await assertFails(setDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-1/report/ficha`),
    fichaFirmada({ evidencia: { antes:'fa', durante:'fa', despues:'fa' } })));
});
test('el borrador sin firmar no exige evidencia', async () => {
  await assertSucceeds(setDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-1/report/ficha`),
    { tipo:'correctivo', materiales:[{descripcion:'Capacitor',cantidad:'1'}],
      updatedAt: serverTimestamp(), updatedBy:'u-tec-a1' }));
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

// ---------------------------------------------------------------------
//  9. Cotizaciones
// ---------------------------------------------------------------------
const baseCot = (extra = {}) => ({
  seq: 1, number: 'COT-0001', clientId: 'cli-1', clientName: 'Hotel Caribe',
  siteId: 'sede-1', siteName: 'Principal', title: 'Cambio de compresor',
  date: '2026-09-26', validUntil: '2026-10-10',
  items: [{ kind: 'repuesto', desc: 'Compresor 24.000 BTU', qty: 1, unitPrice: 1800000 }],
  notes: null, subtotal: 1800000, ivaPct: 19, ivaValue: 342000, total: 2142000,
  status: 'borrador', ...extra,
});
const sembrarCot = async (id, extra = {}) => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `tenants/${A}/quotes/${id}`), { ...baseCot(extra), ...oldStamp });
  });
};

test('la oficina crea una cotización en borrador', async () => {
  await assertSucceeds(setDoc(doc(coordA(), `tenants/${A}/quotes/COT-0001`),
    { ...baseCot(), ...stamp('u-coord-a') }));
});
test('el técnico no crea cotizaciones', async () => {
  await assertFails(setDoc(doc(tecA1(), `tenants/${A}/quotes/COT-0001`),
    { ...baseCot(), ...stamp('u-tec-a1') }));
});
test('una cotización sin líneas se rechaza', async () => {
  await assertFails(setDoc(doc(coordA(), `tenants/${A}/quotes/COT-0001`),
    { ...baseCot({ items: [] }), ...stamp('u-coord-a') }));
});
test('un IVA imposible se rechaza', async () => {
  await assertFails(setDoc(doc(coordA(), `tenants/${A}/quotes/COT-0001`),
    { ...baseCot({ ivaPct: 130 }), ...stamp('u-coord-a') }));
});
test('no se puede crear una cotización ya aprobada', async () => {
  await assertFails(setDoc(doc(coordA(), `tenants/${A}/quotes/COT-0001`),
    { ...baseCot({ status: 'aprobada' }), ...stamp('u-coord-a') }));
});
test('el cliente NO ve los borradores y sí ve las enviadas', async () => {
  await sembrarCot('COT-0001');
  await assertFails(getDoc(doc(clienteA(), `tenants/${A}/quotes/COT-0001`)));
  await sembrarCot('COT-0002', { seq: 2, number: 'COT-0002', status: 'enviada' });
  await assertSucceeds(getDoc(doc(clienteA(), `tenants/${A}/quotes/COT-0002`)));
});
test('el cliente no ve la cotización de otro cliente', async () => {
  await sembrarCot('COT-0003', { seq: 3, number: 'COT-0003', status: 'enviada',
    clientId: 'cli-2', clientName: 'Clínica Norte', siteId: 'sede-2', siteName: 'Norte' });
  await assertFails(getDoc(doc(clienteA(), `tenants/${A}/quotes/COT-0003`)));
});
test('el cliente aprueba la cotización que se le envió', async () => {
  await sembrarCot('COT-0002', { status: 'enviada' });
  await assertSucceeds(updateDoc(doc(clienteA(), `tenants/${A}/quotes/COT-0002`),
    { status: 'aprobada', clientNote: 'Adelante', decidedBy: 'u-cli-a',
      decidedAt: serverTimestamp(), ...upd('u-cli-a') }));
});
test('el cliente rechaza con comentario', async () => {
  await sembrarCot('COT-0002', { status: 'enviada' });
  await assertSucceeds(updateDoc(doc(clienteA(), `tenants/${A}/quotes/COT-0002`),
    { status: 'rechazada', clientNote: 'Muy costoso', decidedBy: 'u-cli-a',
      decidedAt: serverTimestamp(), ...upd('u-cli-a') }));
});
test('el cliente no puede aprobar un borrador', async () => {
  await sembrarCot('COT-0001');
  await assertFails(updateDoc(doc(clienteA(), `tenants/${A}/quotes/COT-0001`),
    { status: 'aprobada', decidedBy: 'u-cli-a', decidedAt: serverTimestamp(), ...upd('u-cli-a') }));
});
test('el cliente no puede cambiar el precio al aprobar', async () => {
  await sembrarCot('COT-0002', { status: 'enviada' });
  await assertFails(updateDoc(doc(clienteA(), `tenants/${A}/quotes/COT-0002`),
    { status: 'aprobada', total: 1, decidedBy: 'u-cli-a', decidedAt: serverTimestamp(), ...upd('u-cli-a') }));
});
test('el cliente no puede aprobar en nombre de otro usuario', async () => {
  await sembrarCot('COT-0002', { status: 'enviada' });
  await assertFails(updateDoc(doc(clienteA(), `tenants/${A}/quotes/COT-0002`),
    { status: 'aprobada', decidedBy: 'u-admin-a', decidedAt: serverTimestamp(), ...upd('u-cli-a') }));
});
test('el cliente no aprueba la cotización de otro cliente', async () => {
  await sembrarCot('COT-0003', { status: 'enviada', clientId: 'cli-2', siteId: 'sede-2' });
  await assertFails(updateDoc(doc(clienteA(), `tenants/${A}/quotes/COT-0003`),
    { status: 'aprobada', decidedBy: 'u-cli-a', decidedAt: serverTimestamp(), ...upd('u-cli-a') }));
});
test('una cotización aprobada ya no se edita desde la oficina', async () => {
  await sembrarCot('COT-0002', { status: 'aprobada' });
  await assertFails(updateDoc(doc(coordA(), `tenants/${A}/quotes/COT-0002`),
    { total: 99, ...upd('u-coord-a') }));
});
test('a la aprobada se le pega la orden generada, una sola vez', async () => {
  await sembrarCot('COT-0002', { status: 'aprobada' });
  const ref = doc(coordA(), `tenants/${A}/quotes/COT-0002`);
  await assertSucceeds(updateDoc(ref, { resultOrderId: 'OT-0009', ...upd('u-coord-a') }));
  await env.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), `tenants/${A}/quotes/COT-0002`), { resultOrderId: 'OT-0009' });
  });
  await assertFails(updateDoc(ref, { resultOrderId: 'OT-0010', ...upd('u-coord-a') }));
});
test('la oficina sí edita un borrador y lo envía', async () => {
  await sembrarCot('COT-0001');
  await assertSucceeds(updateDoc(doc(coordA(), `tenants/${A}/quotes/COT-0001`),
    { status: 'enviada', total: 2500000, ...upd('u-coord-a') }));
});
test('nadie borra una cotización', async () => {
  await sembrarCot('COT-0001');
  await assertFails(deleteDoc(doc(adminA(), `tenants/${A}/quotes/COT-0001`)));
});
test('la empresa B no ve las cotizaciones de A', async () => {
  await sembrarCot('COT-0001', { status: 'enviada' });
  await assertFails(getDoc(doc(adminB(), `tenants/${A}/quotes/COT-0001`)));
});

// ---------------------------------------------------------------------
//  10. Preparación de la factura
// ---------------------------------------------------------------------
const baseFac = (extra = {}) => ({
  seq: 1, number: 'PRE-0001', clientId: 'cli-1', clientName: 'Hotel Caribe', clientNit: '900.123-4',
  period: '2026-09', date: '2026-09-30', dueDate: '2026-10-30', kind: 'consolidado',
  orderIds: ['ot-1'], contractId: null, consecutivo: null,
  items: [{ desc: 'Mantenimiento preventivo septiembre', qty: 1, unitPrice: 900000, kind: 'servicio' }],
  notes: null, subtotal: 900000, ivaPct: 19, ivaValue: 171000, total: 1071000,
  status: 'borrador', siigoNumero: null, ...extra,
});
const sembrarFac = async (id, extra = {}) => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `tenants/${A}/invoices/${id}`), { ...baseFac(extra), ...oldStamp });
  });
};

test('la oficina crea un borrador de factura', async () => {
  await assertSucceeds(setDoc(doc(coordA(), `tenants/${A}/invoices/PRE-0001`),
    { ...baseFac(), ...stamp('u-coord-a') }));
});
test('el técnico no crea ni lee borradores de factura', async () => {
  await assertFails(setDoc(doc(tecA1(), `tenants/${A}/invoices/PRE-0001`), { ...baseFac(), ...stamp('u-tec-a1') }));
  await sembrarFac('PRE-0001');
  await assertSucceeds(getDoc(doc(tecA1(), `tenants/${A}/invoices/PRE-0001`)));  // el técnico es staff: solo lee
});
test('el cliente NO ve los borradores de factura', async () => {
  await sembrarFac('PRE-0001');
  await assertFails(getDoc(doc(clienteA(), `tenants/${A}/invoices/PRE-0001`)));
});
test('no se puede crear una factura ya marcada como facturada', async () => {
  await assertFails(setDoc(doc(coordA(), `tenants/${A}/invoices/PRE-0001`),
    { ...baseFac({ status: 'facturada', siigoNumero: 'FV-1001' }), ...stamp('u-coord-a') }));
});
test('un borrador sin líneas se rechaza', async () => {
  await assertFails(setDoc(doc(coordA(), `tenants/${A}/invoices/PRE-0001`),
    { ...baseFac({ items: [] }), ...stamp('u-coord-a') }));
});
test('un periodo mal escrito se rechaza', async () => {
  await assertFails(setDoc(doc(coordA(), `tenants/${A}/invoices/PRE-0001`),
    { ...baseFac({ period: 'septiembre' }), ...stamp('u-coord-a') }));
});
test('la oficina edita el borrador y lo deja listo', async () => {
  await sembrarFac('PRE-0001');
  await assertSucceeds(updateDoc(doc(coordA(), `tenants/${A}/invoices/PRE-0001`),
    { status: 'lista', total: 1100000, ...upd('u-coord-a') }));
});
test('se anota el número real de la factura y queda congelada', async () => {
  await sembrarFac('PRE-0001', { status: 'lista' });
  const ref = doc(coordA(), `tenants/${A}/invoices/PRE-0001`);
  await assertSucceeds(updateDoc(ref, { status: 'facturada', siigoNumero: 'FV-1001', ...upd('u-coord-a') }));
  await assertFails(updateDoc(ref, { total: 1, ...upd('u-coord-a') }));
});
test('no se cambia el cliente de una factura', async () => {
  await sembrarFac('PRE-0001');
  await assertFails(updateDoc(doc(coordA(), `tenants/${A}/invoices/PRE-0001`),
    { clientId: 'cli-2', ...upd('u-coord-a') }));
});
test('nadie borra un borrador de factura', async () => {
  await sembrarFac('PRE-0001');
  await assertFails(deleteDoc(doc(adminA(), `tenants/${A}/invoices/PRE-0001`)));
});
test('la empresa B no ve las facturas de A', async () => {
  await sembrarFac('PRE-0001');
  await assertFails(getDoc(doc(adminB(), `tenants/${A}/invoices/PRE-0001`)));
});
test('el contrato admite una cuota mensual pactada', async () => {
  await assertSucceeds(setDoc(doc(coordA(), `tenants/${A}/contracts/ct-1`),
    { name: 'Preventivo Hotel Caribe', clientId: 'cli-1', siteIds: ['sede-1'], frequency: 'mensual',
      mode: 'visita', startDate: '2026-01-01', status: 'activo', valorMensual: 900000, ...stamp('u-coord-a') }));
});
test('una cuota mensual negativa se rechaza', async () => {
  await assertFails(setDoc(doc(coordA(), `tenants/${A}/contracts/ct-2`),
    { name: 'Preventivo', clientId: 'cli-1', siteIds: [], frequency: 'mensual',
      mode: 'visita', startDate: '2026-01-01', status: 'activo', valorMensual: -5, ...stamp('u-coord-a') }));
});

// ---------------------------------------------------------------------
//  11. Gastos y anticipos
// ---------------------------------------------------------------------
const baseGasto = (extra = {}) => ({
  seq: 1, number: 'GA-0001', date: '2026-09-20', category: 'Combustible',
  concept: 'Tanqueada camioneta ida a Soledad', amount: 90000, fuente: 'reembolsable',
  techId: 'tec-1', techUid: 'u-tec-a1', techName: 'Carlos Pérez',
  orderId: 'ot-1', orderNumber: 'OT-0001', proveedor: 'Terpel', nit: null, soporte: 'F-9912',
  nota: null, status: 'pendiente', aprobadoPor: null, pagado: false, pagadoEl: null, advanceId: null, ...extra,
});
const sembrarGasto = async (id, extra = {}) => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `tenants/${A}/expenses/${id}`), { ...baseGasto(extra), ...oldStamp });
  });
};

test('el técnico registra su propio gasto', async () => {
  await assertSucceeds(setDoc(doc(tecA1(), `tenants/${A}/expenses/GA-0001`),
    { ...baseGasto(), ...stamp('u-tec-a1') }));
});
test('el técnico NO puede registrar un gasto a nombre de otro', async () => {
  await assertFails(setDoc(doc(tecA1(), `tenants/${A}/expenses/GA-0001`),
    { ...baseGasto({ techUid: 'u-tec-a2' }), ...stamp('u-tec-a1') }));
});
test('el técnico no puede aprobarse el gasto él mismo', async () => {
  await assertFails(setDoc(doc(tecA1(), `tenants/${A}/expenses/GA-0001`),
    { ...baseGasto({ status: 'aprobado' }), ...stamp('u-tec-a1') }));
  await sembrarGasto('GA-0002');
  await assertFails(updateDoc(doc(tecA1(), `tenants/${A}/expenses/GA-0002`),
    { status: 'aprobado', ...upd('u-tec-a1') }));
});
test('el técnico no puede marcarse el reembolso como pagado', async () => {
  await sembrarGasto('GA-0001');
  await assertFails(updateDoc(doc(tecA1(), `tenants/${A}/expenses/GA-0001`),
    { pagado: true, ...upd('u-tec-a1') }));
});
test('el técnico corrige su gasto mientras está pendiente, no después', async () => {
  await sembrarGasto('GA-0001');
  await assertSucceeds(updateDoc(doc(tecA1(), `tenants/${A}/expenses/GA-0001`),
    { amount: 95000, concept: 'Tanqueada camioneta, ida y vuelta', ...upd('u-tec-a1') }));
  await sembrarGasto('GA-0003', { status: 'aprobado' });
  await assertFails(updateDoc(doc(tecA1(), `tenants/${A}/expenses/GA-0003`),
    { amount: 500000, ...upd('u-tec-a1') }));
});
test('un gasto en cero o negativo se rechaza', async () => {
  await assertFails(setDoc(doc(tecA1(), `tenants/${A}/expenses/GA-0001`),
    { ...baseGasto({ amount: 0 }), ...stamp('u-tec-a1') }));
  await assertFails(setDoc(doc(tecA1(), `tenants/${A}/expenses/GA-0004`),
    { ...baseGasto({ number: 'GA-0004', amount: -1000 }), ...stamp('u-tec-a1') }));
});
test('un técnico NO ve los gastos de otro técnico', async () => {
  await sembrarGasto('GA-0001');
  await assertSucceeds(getDoc(doc(tecA1(), `tenants/${A}/expenses/GA-0001`)));
  await assertFails(getDoc(doc(tecA2(), `tenants/${A}/expenses/GA-0001`)));
});
test('EL CLIENTE NO VE NINGÚN GASTO', async () => {
  await sembrarGasto('GA-0001', { orderId: 'ot-1', orderNumber: 'OT-0001' });
  await assertFails(getDoc(doc(clienteA(), `tenants/${A}/expenses/GA-0001`)));
  await assertFails(getDocs(query(collection(clienteA(), `tenants/${A}/expenses`))));
  await assertFails(getDoc(doc(clienteA(), `tenants/${A}/expenses/GA-0001/file/recibo`)));
});
test('la oficina aprueba el gasto y luego marca el reembolso', async () => {
  await sembrarGasto('GA-0001');
  const ref = doc(coordA(), `tenants/${A}/expenses/GA-0001`);
  await assertSucceeds(updateDoc(ref, { status: 'aprobado', aprobadoPor: 'u-coord-a', ...upd('u-coord-a') }));
  await assertSucceeds(updateDoc(ref, { pagado: true, pagadoEl: '2026-10-05', ...upd('u-coord-a') }));
});
test('la oficina registra un gasto de la empresa, sin técnico', async () => {
  await assertSucceeds(setDoc(doc(coordA(), `tenants/${A}/expenses/GA-0009`),
    { ...baseGasto({ number: 'GA-0009', seq: 9, category: 'Arriendo', concept: 'Arriendo bodega septiembre',
      amount: 2500000, fuente: 'empresa', techId: null, techUid: null, techName: null,
      orderId: null, orderNumber: null, status: 'aprobado', aprobadoPor: 'u-coord-a' }), ...stamp('u-coord-a') }));
});
test('nadie borra un gasto', async () => {
  await sembrarGasto('GA-0001');
  await assertFails(deleteDoc(doc(adminA(), `tenants/${A}/expenses/GA-0001`)));
});
test('la empresa B no ve los gastos de A', async () => {
  await sembrarGasto('GA-0001');
  await assertFails(getDoc(doc(adminB(), `tenants/${A}/expenses/GA-0001`)));
});
test('la foto del recibo la guarda el dueño del gasto y la lee la oficina', async () => {
  await sembrarGasto('GA-0001');
  const img = 'data:image/jpeg;base64,' + 'A'.repeat(500);
  await assertSucceeds(setDoc(doc(tecA1(), `tenants/${A}/expenses/GA-0001/file/recibo`), { data: img }));
  await assertSucceeds(getDoc(doc(coordA(), `tenants/${A}/expenses/GA-0001/file/recibo`)));
  await assertFails(setDoc(doc(tecA2(), `tenants/${A}/expenses/GA-0001/file/recibo`), { data: img }));
});

const baseAnticipo = (extra = {}) => ({
  seq: 1, number: 'AN-0001', date: '2026-09-01', techId: 'tec-1', techUid: 'u-tec-a1',
  techName: 'Carlos Pérez', amount: 300000, devuelto: 0, status: 'abierto', nota: null, ...extra,
});
test('la oficina entrega un anticipo y el técnico lo ve', async () => {
  await assertSucceeds(setDoc(doc(coordA(), `tenants/${A}/advances/AN-0001`),
    { ...baseAnticipo(), ...stamp('u-coord-a') }));
  await assertSucceeds(getDoc(doc(tecA1(), `tenants/${A}/advances/AN-0001`)));
  await assertFails(getDoc(doc(tecA2(), `tenants/${A}/advances/AN-0001`)));
  await assertFails(getDoc(doc(clienteA(), `tenants/${A}/advances/AN-0001`)));
});
test('el técnico no se entrega anticipos a sí mismo', async () => {
  await assertFails(setDoc(doc(tecA1(), `tenants/${A}/advances/AN-0002`),
    { ...baseAnticipo({ number: 'AN-0002' }), ...stamp('u-tec-a1') }));
});
test('no se le cambia el monto a un anticipo ya entregado', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `tenants/${A}/advances/AN-0001`), { ...baseAnticipo(), ...oldStamp });
  });
  await assertFails(updateDoc(doc(coordA(), `tenants/${A}/advances/AN-0001`),
    { amount: 5000000, ...upd('u-coord-a') }));
  await assertSucceeds(updateDoc(doc(coordA(), `tenants/${A}/advances/AN-0001`),
    { devuelto: 50000, status: 'cerrado', ...upd('u-coord-a') }));
});

// ---------------------------------------------------------------------
//  12. Reabrir un reporte ya firmado
// ---------------------------------------------------------------------
const fichaConFirma = (extra = {}) => ({
  tipo: 'preventivo', horaEntrada: '08:00', horaSalida: '10:00',
  actividad: 'Mantenimiento completo', materiales: [],
  firmaCliente: 'data:image/png;base64,AAA', firmaClienteNombre: 'María Torres',
  firmaTecnico: 'data:image/png;base64,BBB', firmaTecnicoNombre: 'Carlos Pérez',
  createdAt: now, createdBy: 'u-tec-a1', ...extra,
});
const sembrarFirmado = async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `tenants/${A}/workOrders/ot-1/report/ficha`),
      { ...fichaConFirma(), updatedAt: now, updatedBy: 'u-tec-a1' });
  });
};
const reapertura = (uid, extra = {}) => ({
  ...fichaConFirma(), firmaCliente: null, firmaTecnico: null,
  reabiertoPor: uid, reabiertoEl: serverTimestamp(), reabiertoMotivo: 'El técnico firmó en el campo equivocado',
  updatedAt: serverTimestamp(), updatedBy: uid, ...extra,
});

test('el técnico NO puede tocar un reporte ya firmado', async () => {
  await sembrarFirmado();
  await assertFails(setDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-1/report/ficha`),
    { ...fichaConFirma({ actividad: 'otra cosa' }), updatedAt: serverTimestamp(), updatedBy: 'u-tec-a1' }));
});
test('el técnico tampoco puede reabrirlo él mismo', async () => {
  await sembrarFirmado();
  await assertFails(setDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-1/report/ficha`),
    reapertura('u-tec-a1')));
});
test('el cliente no puede reabrir lo que ya firmó', async () => {
  await sembrarFirmado();
  await assertFails(setDoc(doc(clienteA(), `tenants/${A}/workOrders/ot-1/report/ficha`),
    reapertura('u-cli-a')));
});
test('la oficina reabre el reporte y las firmas se borran', async () => {
  await sembrarFirmado();
  await assertSucceeds(setDoc(doc(coordA(), `tenants/${A}/workOrders/ot-1/report/ficha`),
    reapertura('u-coord-a')));
});
test('al reabrir no se puede dejar ninguna de las dos firmas', async () => {
  await sembrarFirmado();
  await assertFails(setDoc(doc(coordA(), `tenants/${A}/workOrders/ot-1/report/ficha`),
    reapertura('u-coord-a', { firmaCliente: 'data:image/png;base64,AAA' })));
  await assertFails(setDoc(doc(coordA(), `tenants/${A}/workOrders/ot-1/report/ficha`),
    reapertura('u-coord-a', { firmaTecnico: 'data:image/png;base64,BBB' })));
});
test('la reapertura exige motivo y queda a nombre de quien la hizo', async () => {
  await sembrarFirmado();
  await assertFails(setDoc(doc(coordA(), `tenants/${A}/workOrders/ot-1/report/ficha`),
    reapertura('u-coord-a', { reabiertoMotivo: '' })));
  await assertFails(setDoc(doc(coordA(), `tenants/${A}/workOrders/ot-1/report/ficha`),
    reapertura('u-coord-a', { reabiertoPor: 'u-admin-a' })));
});
test('la empresa B no puede reabrir un reporte de A', async () => {
  await sembrarFirmado();
  await assertFails(setDoc(doc(adminB(), `tenants/${A}/workOrders/ot-1/report/ficha`),
    reapertura('u-admin-b')));
});
test('reabierto, el técnico vuelve a corregir y a firmar', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `tenants/${A}/workOrders/ot-1/report/ficha`),
      { ...fichaConFirma(), firmaCliente: null, firmaTecnico: null,
        reabiertoPor: 'u-coord-a', reabiertoEl: now, reabiertoMotivo: 'Firmas cruzadas',
        updatedAt: now, updatedBy: 'u-coord-a' });
  });
  await assertSucceeds(setDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-1/report/ficha`),
    { ...fichaConFirma({ firmaClienteNombre: 'María Torres (correcta)' }),
      reabiertoPor: 'u-coord-a', reabiertoEl: now, reabiertoMotivo: 'Firmas cruzadas',
      updatedAt: serverTimestamp(), updatedBy: 'u-tec-a1' }));
});
test('y vuelto a firmar, queda cerrado otra vez', async () => {
  await sembrarFirmado();
  await assertFails(setDoc(doc(tecA1(), `tenants/${A}/workOrders/ot-1/report/ficha`),
    { ...fichaConFirma({ actividad: 'cambiado a escondidas' }),
      updatedAt: serverTimestamp(), updatedBy: 'u-tec-a1' }));
});
