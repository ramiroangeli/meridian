import type { Run } from "./db";

// Datos de ejemplo: los mismos del prototipo, ahora guardados en la base.
const MIN = 60_000;
const ago = (min: number) => new Date(Date.now() - min * MIN);
const ahead = (min: number) => new Date(Date.now() + min * MIN);
const monthsBack = (n: number) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 7); };

export async function seed(run: Run) {
  const u = await run("insert into users (email, name, base_currency, demo) values ($1,$2,'AUD',true) returning id", ["demo@meridiano.local", "Perfil de ejemplo"]);
  const uid = u[0].id as string;
  for (const [c, r] of [["AUD", 1], ["USD", 0.65], ["EUR", 0.6]] as const) await run("insert into fx_rates values ($1,$2,$3)", [uid, c, r]);

  const accounts: [string, string, string, string, number | null, number, string, string, string, number][] = [
    ["Banco AU principal", "Banco", "AU", "AUD", 6420, 6420, "Efectivo", "Gasto diario y cobros", "CSV mensual", 2880],
    ["Banco AU reserva fiscal", "Banco", "AU", "AUD", 4400, 4400, "Efectivo", "Impuestos apartados", "CSV mensual", 2880],
    ["Exchange cripto: BTC", "Exchange", "AU", "BTC", 0.0572, 9100, "Bitcoin", "Largo plazo", "API solo lectura", 4],
    ["Exchange cripto: otras", "Exchange", "AU", "Varias", null, 3850, "Otras cripto", "Largo plazo", "API solo lectura", 4],
    ["Exchange cripto: saldo AUD", "Exchange", "AU", "AUD", 2000, 2000, "Efectivo", "Pendiente de invertir", "API solo lectura", 4],
    ["Bróker UE: ETF", "Bróker", "UE", "EUR", 9800, 16333, "ETF renta variable", "Largo plazo", "CSV oficial", 17280],
    ["Banco ES", "Banco", "UE", "EUR", 2300, 3833, "Efectivo", "Reserva en euros", "Manual", 48960],
    ["Cuenta multidivisa A", "Dinero electrónico", "UE", "EUR", 1150, 1917, "Efectivo", "Viajes y transferencias", "CSV mensual", 17280],
    ["Cuenta multidivisa B", "Dinero electrónico", "UE", "EUR", 380, 633, "Efectivo", "Viajes", "Manual", 48960],
    ["Banco digital AR", "Banco", "AR", "USD", 500, 769, "Efectivo", "Estadías en Argentina", "Manual", 87840],
    ["Billetera AR", "Billetera", "AR", "ARS", 310000, 344, "Efectivo", "Estadías en Argentina", "Manual", 87840],
  ];
  const ids: Record<string, string> = {};
  for (const a of accounts) {
    const r = await run("insert into accounts (user_id,name,kind,zone,currency,asset_class,purpose,connection) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id", [uid, a[0], a[1], a[2], a[3], a[6], a[7], a[8]]);
    ids[a[0]] = r[0].id;
    await run("insert into balances (user_id,account_id,native_amount,base_amount,as_of,source) values ($1,$2,$3,$4,$5,'seed')", [uid, r[0].id, a[4], a[5], ago(a[9])]);
  }
  await run("insert into liabilities (user_id,name,zone,base_amount,note) values ($1,$2,'AU',4650,$3)", [uid, "Impuesto estimado del año en curso", "Cubierto por la cuenta de reserva fiscal"]);

  const hist = [31200, 32100, 33900, 33100, 35400, 36800, 36100, 38900, 40700, 41200, 43600, 44949];
  for (let i = 0; i < 12; i++) await run("insert into net_worth_history values ($1,$2,$3,$4)", [uid, monthsBack(11 - i), hist[i], 31200 + 1100 * i]);

  const main = ids["Banco AU principal"];
  const flow = { income: [5100, 4800, 5300, 4950, 5200, 5000], ess: [2100, 2050, 2200, 2150, 2080, 2120], dis: [700, 950, 640, 880, 720, 690], tax: [1122, 1056, 1166, 1089, 1144, 1100] };
  for (let i = 0; i < 6; i++) {
    const m = monthsBack(5 - i);
    const rows: [number, string, string, boolean, string][] = [
      [flow.income[i], "Cobros del mes", "income", false, "Ingresos"],
      [-flow.ess[i], "Alquiler, comida, transporte", "expense", true, "Esenciales"],
      [-flow.dis[i], "Salidas, viajes, compras", "expense", false, "Discrecionales"],
      [-flow.tax[i], "A la cuenta de reserva fiscal", "tax_reserve", false, "Impuestos"],
    ];
    for (const [k, r] of rows.entries())
      await run("insert into transactions (user_id,account_id,posted_on,amount,description,kind,essential,category,external_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [uid, main, `${m}-15`, r[0], r[1], r[2], r[3], r[4], `seed-${m}-${k}`]);
  }

  // código, nombre, estado, tarea, resultado, última (min atrás), próxima (min adelante | null), nota de próxima, ficha…
  const agents: [string, string, string | null, string, string, number | null, number | null, string | null, string, string, string, string, string, string, string, string][] = [
    ["A", "Coordinador financiero", "done", "Resumen semanal", "3 propuestas priorizadas", 420, 9660, null, "Mantiene el plan maestro, prioriza tareas y detecta contradicciones entre agentes.", "Salidas de todos los agentes, registro de decisiones", "Resumen semanal, backlog priorizado", "Lectura total. No ejecuta operaciones.", "Propuestas aceptadas sobre propuestas enviadas", "Todos", "Dos agentes proponen acciones opuestas", "AUD 6 por mes"],
    ["B", "Contabilidad y flujo de caja", "wait", "Conciliación del mes", "Falta el extracto del Banco ES", 2880, null, "al recibir el CSV", "Consolida ingresos, gastos, activos y pasivos. Concilia cuentas y separa transferencias internas.", "Exportaciones CSV, app de gastos", "Cierre mensual, previsión de liquidez a 90 días", "Lectura. Clasifica y concilia sin autorización.", "Movimientos sin clasificar; diferencia de conciliación", "Conexiones", "Diferencia de conciliación mayor al 1%", "AUD 4 por mes"],
    ["C", "Ingresos y desarrollo económico", null, "Sin tareas", "Rol todavía no implementado", null, null, null, "Compara oportunidades de ingreso por beneficio neto, probabilidad, horas y costo de oportunidad.", "Ingresos por fuente, horas disponibles", "Informe trimestral de oportunidades", "Solo análisis.", "Ingreso neto por hora", "Contabilidad", "Caída de ingresos mayor al 20% en un mes", "Sin costo"],
    ["D", "Psicología y hábitos", "prog", "Revisión del diario de decisiones", "1 período de espera activo", 8640, 4320, null, "Propone períodos de espera, límites y diario de decisiones. No hace diagnósticos.", "Decisiones registradas, preferencias declaradas", "Revisión mensual de decisiones", "Solo análisis.", "Decisiones tomadas fuera de las reglas", "Coordinador", "Tres compras impulsivas en 30 días", "AUD 1 por mes"],
    ["E", "Estrategia patrimonial", "appr", "Rebalanceo trimestral", "Propuesta lista para revisar", 1100, null, "tras tu decisión", "Define objetivos, horizontes y asignación entre clases de activos según la política de inversión.", "Posiciones, política de inversión, objetivos", "Revisión trimestral de asignación", "Propone. Toda operación requiere tu autorización.", "Desvío respecto de la asignación objetivo", "Contabilidad, Mercados", "Un límite de concentración se supera", "AUD 3 por mes"],
    ["F", "Mercados y análisis cuantitativo", "run", "Cálculo de volatilidad y correlaciones", "62% completado", 6, 1200, null, "Analiza escenarios, volatilidad, correlaciones y concentración. Compara contra comprar y mantener.", "Precios históricos, posiciones", "Resumen diario breve, pruebas de estrés mensuales", "Lectura de mercados.", "Alertas útiles sobre alertas enviadas", "Conexión al exchange", "Caída mayor al 15% en 7 días en un activo relevante", "AUD 8 por mes"],
    ["G", "Operativa y ejecución", "prog", "Verificación posterior a órdenes", "Última orden verificada sin diferencias", 12960, null, "tras cada aprobación", "Convierte decisiones aprobadas en instrucciones precisas y verifica el resultado real.", "Saldos, órdenes abiertas, comisiones", "Lista de revisión por operación", "Prepara borradores. No envía órdenes.", "Diferencia entre lo aprobado y lo ejecutado", "Estrategia, Seguridad", "Saldo insuficiente u orden duplicada", "AUD 2 por mes"],
    ["H", "Divisas y transferencias", "done", "Comparación de rutas AUD a EUR", "Ruta más barata: 0,6% de costo total", 480, null, "a pedido", "Compara rutas entre cuentas y países por costo efectivo total, plazo y documentación.", "Tipos de cambio, comisiones publicadas", "Comparación por ruta: sale, llega, tarda", "Solo análisis.", "Costo cambiario pagado sobre monto transferido", "Contabilidad", "Margen cambiario mayor al 2%", "AUD 2 por mes"],
    ["I", "Fiscalidad internacional", "appr", "Calendario fiscal del trimestre", "2 fechas requieren confirmación", 4320, null, "tras tu decisión", "Organiza obligaciones, documentación y fechas por país. Prepara preguntas para profesionales.", "Residencia, cuentas por país, ingresos", "Calendario fiscal, lista de preguntas", "Solo análisis. No presenta nada.", "Vencimientos cumplidos a tiempo", "Contabilidad", "Vencimiento a menos de 14 días sin reserva suficiente", "AUD 3 por mes"],
    ["J", "Seguridad y custodia", "err", "Auditoría de permisos de API", "No pudo leer los permisos de una clave", 540, 180, null, "Revisa permisos, autenticación, copias de seguridad y custodia.", "Inventario de claves y accesos", "Auditoría mensual de accesos", "Lectura de configuración.", "Claves con permisos superiores al mínimo", "Conexiones", "Una clave permite retiros", "AUD 1 por mes"],
    ["K", "Profesor de finanzas", "prog", "Lección 4: rentabilidad ponderada por dinero", "3 de 12 lecciones completadas", 7200, 2880, null, "Arma un programa de aprendizaje con tus propios números y comprueba tu comprensión.", "Tus datos, progreso de lecciones", "Una lección por semana", "Solo análisis.", "Lecciones completadas; ejercicios correctos", "Coordinador", "Ninguna", "AUD 2 por mes"],
    ["L", "Producto, datos y automatizaciones", "done", "Copia de seguridad de la base", "Copia verificada", 600, 840, null, "Mantiene integraciones, almacenamiento, tablero y operación técnica.", "Registros del sistema", "Estado de conexiones, copias diarias", "Administra infraestructura. Sin acceso a fondos.", "Conexiones al día; costo mensual", "Ninguna", "Una conexión falla dos veces seguidas", "AUD 5 por mes"],
  ];
  for (const a of agents) {
    const r = await run("insert into agents (user_id,code,name,objective,data,deliverables,permissions,kpi,depends_on,escalation,cost_note,implemented) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id", [uid, a[0], a[1], a[8], a[9], a[10], a[11], a[12], a[13], a[14], a[15], a[2] !== null]);
    if (a[2]) await run("insert into agent_runs (user_id,agent_id,status,task,result,started_at,finished_at,next_run_at,next_note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [uid, r[0].id, a[2], a[3], a[4], ago(a[5] ?? 0), a[2] === "run" ? null : ago(a[5] ?? 0), a[6] ? ahead(a[6]) : null, a[7]]);
  }

  const props: string[][] = [
    ["I", "urg", "La reserva fiscal queda AUD 250 por debajo del impuesto estimado", "Reserva AUD 4.400 contra impuesto estimado AUD 4.650 al cierre del mes.", "Evita usar ahorros al vencimiento", "5 minutos", "Bajo", "Transferir AUD 250 del banco principal a la reserva"],
    ["E", "rev", "Rebalanceo: las criptomonedas superan el límite de concentración", "Cripto es el 26,1% de los activos; el límite de la política de ejemplo es 25%.", "Vuelve al rango definido", "20 minutos", "Medio: puede generar impuesto por la venta", "Revisar el borrador de órdenes y el efecto fiscal"],
    ["I", "rev", "Confirmar dos fechas del calendario fiscal", "Dos vencimientos dependen de tu residencia fiscal declarada.", "Evita recargos", "10 minutos", "Bajo", "Confirmar con tu asesor y marcar las fechas"],
    ["H", "sum", "Ruta más barata para pasar AUD a EUR este mes", "Comparación de 4 rutas para AUD 2.000: costo total entre 0,6% y 2,3%.", "Hasta AUD 34 por transferencia", "Ninguno", "Bajo", "Usarla en la próxima transferencia"],
    ["J", "idea", "Evaluar custodia propia para la posición de largo plazo", "El 100% de las criptomonedas está en un exchange.", "Reduce el riesgo de contraparte", "2 a 3 horas", "Medio: errores al resguardar la frase de recuperación", "Leer la guía de custodia y decidir"],
  ];
  for (const [i, p] of props.entries()) await run("insert into proposals (user_id,agent_code,level,title,evidence,benefit,effort,risk,next_step,created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [uid, ...p, ago(60 * (i + 1))]);

  const events: [number, string, string, string][] = [
    [5760, "Vos", "Aprobaste: transferencia de AUD 1.100 a la reserva fiscal", "Ejecutada por vos y verificada"],
    [15840, "Vos", "Rechazaste: compra adicional de una criptomoneda menor", "Motivo: fuera de la política"],
    [21600, "Agente B", "Cierre del mes anterior conciliado", "Diferencia AUD 0"],
    [27360, "Vos", "Otorgaste clave de solo lectura al exchange", "Sin permisos de operación ni retiro"],
  ];
  for (const e of events) await run("insert into events (user_id,at,actor,action,result) values ($1,$2,$3,$4,$5)", [uid, ago(e[0]), e[1], e[2], e[3]]);

  const fiscal: string[][] = [
    ["28 nov", "AU", "Declaración trimestral de actividad, si corresponde", "appr"],
    ["31 dic", "UE", "Fecha de corte para saldos en el exterior", "prog"],
    ["28 feb", "AU", "Declaración trimestral de actividad, si corresponde", "prog"],
    ["31 mar", "UE", "Declaración informativa de bienes en el exterior, si corresponde", "appr"],
    ["30 jun", "AU", "Cierre del año fiscal", "prog"],
    ["31 oct", "AU", "Vencimiento de la declaración anual", "prog"],
  ];
  for (const f of fiscal) await run("insert into fiscal_items (user_id,due,zone,title,status) values ($1,$2,$3,$4,$5)", [uid, ...f]);
}
