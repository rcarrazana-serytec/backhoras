const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true
}));

const dbHost = process.env.DB_HOST;
const dbUser = process.env.DB_USER;
const dbPassword = process.env.DB_PASSWORD;
const dbName = process.env.DB_NAME;
const dbPort = parseInt(process.env.DB_PORT, 10) || 3306;

if (!dbHost || !dbUser || !dbPassword || !dbName) {
  console.error('Faltan variables de entorno de base de datos. Crea un archivo .env con DB_HOST, DB_USER, DB_PASSWORD, DB_NAME y opcionalmente DB_PORT.');
  process.exit(1);
}

const db = mysql.createConnection({
  host: dbHost,
  user: dbUser,
  password: dbPassword,
  database: dbName,
  port: dbPort
});

db.connect((err) => {
  if (err) {
    console.error('Error al conectar a la base de datos:', err.message);
    return;
  }
  console.log('¡Conectado exitosamente a la base de datos remota!');
});

// ─── Ruta de prueba ──────────────────────────────────────────────────────────
app.get('/prueba', (req, res) => {
  res.json({ mensaje: '¡El servidor está enviando datos correctamente!' });
});

// ─── Catálogos (provincias, vehículos, operarios) ────────────────────────────
app.get('/catalogos', (req, res) => {
  const qProv = 'SELECT id, provincia FROM ma_provincias';
  const qVeh = 'SELECT id, patente FROM ma_vehiculos WHERE activo = 1';
  const qEmp = "SELECT cuil, apellido_nombre FROM snuempleados WHERE categoria NOT IN ('ADMINISTRATIVO B', 'SOCIO GERENTE', 'ENCARGADO') AND activo = 'S'";

  db.query(qProv, (e1, provs) => {
    if (e1) console.error('Error qProv:', e1.message);
    db.query(qVeh, (e2, vehs) => {
      if (e2) console.error('Error qVeh:', e2.message);
      db.query(qEmp, (e3, emps) => {
        if (e3) console.error('Error qEmp:', e3.message);
        res.json({
          provincias: provs || [],
          vehiculos: vehs || [],
          operarios: emps || []
        });
      });
    });
  });
});

// ─── Contratos con sus tareas (desde ma_contrato_tareas) ─────────────────────
app.get('/contratos-tareas', (req, res) => {
  const q = `
    SELECT id, contrato, tarea
    FROM ma_contrato_tareas
    WHERE activo = 1
    ORDER BY contrato, tarea
  `;
  db.query(q, (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Error al obtener contratos' });
    }
    // Agrupar por contrato: [{ contrato: 'K2', tareas: [{ id, tarea }] }]
    const agrupado = {};
    rows.forEach(row => {
      if (!agrupado[row.contrato]) {
        agrupado[row.contrato] = { contrato: row.contrato, tareas: [] };
      }
      agrupado[row.contrato].tareas.push({ id: row.id, tarea: row.tarea });
    });
    res.json(Object.values(agrupado));
  });
});

// ─── Autenticación / Perfil ────────────────────────────────────────────────────
app.get('/auth/perfil', (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'Email requerido' });

  db.query('SELECT grupo FROM ma_jefes WHERE email = ? LIMIT 1', [email], (err, results) => {
    if (err) return res.status(500).json({ error: 'Error DB' });
    if (results.length > 0) {
      res.json({ esJefe: true, grupo: results[0].grupo });
    } else {
      res.json({ esJefe: false });
    }
  });
});

// ─── Reporte completo (Filtro por email) ───────────────────────────────────────
app.get('/reporte-completo', (req, res) => {
  const email = req.query.email;
  let whereClause = '';
  const queryParams = [];

  if (email) {
    whereClause = 'WHERE t.email = ?';
    queryParams.push(email);
  }

  const query = `
    SELECT
      t.id, t.dia, t.contrato, t.observaciones,
      t.estado_g1, t.estado_g2, t.estado_g3,
      t.horas_k2, t.horas_k5, t.horas_k6, t.horas_k8, t.horas_k9, t.horas_k10, t.horas_k11, t.horas_k12, t.horas_otros,
      p.provincia AS nombre_provincia,
      v.patente AS patente_vehiculo,
      GROUP_CONCAT(DISTINCT e.apellido_nombre SEPARATOR ', ') AS operarios_nombres
    FROM db_tareas_contratos t
    LEFT JOIN ma_provincias p ON t.provincia = p.id
    LEFT JOIN ma_vehiculos v ON t.moviles = v.id
    LEFT JOIN snuempleados e ON e.cuil != '' AND FIND_IN_SET(e.cuil, t.operarios_cuil) > 0
    ${whereClause}
    GROUP BY t.id
    ORDER BY t.dia DESC
  `;
  db.query(query, queryParams, (err, results) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Error en la consulta');
    }
    res.json(results);
  });
});

// ─── Reporte de Horas por Quincena ───────────────────────────────────────────
app.get('/reporte-horas', (req, res) => {
  const { email, mes, quincena, anio } = req.query;
  
  if (!email || !mes || !quincena || !anio) {
    return res.status(400).json({ error: 'Faltan parámetros' });
  }

  const m = parseInt(mes, 10);
  const q = parseInt(quincena, 10);
  const a = parseInt(anio, 10);

  const query = `
    SELECT 
      SUM(horas_k2) AS K2,
      SUM(horas_k5) AS K5,
      SUM(horas_k6) AS K6,
      SUM(horas_k8) AS K8,
      SUM(horas_k9) AS K9,
      SUM(horas_k10) AS K10,
      SUM(horas_k11) AS K11,
      SUM(horas_k12) AS K12,
      SUM(horas_otros) AS OTROS
    FROM db_tareas_contratos
    WHERE email = ? 
      AND YEAR(dia) = ?
      AND MONTH(dia) = ?
      AND (
        (? = 1 AND DAY(dia) <= 15) OR 
        (? = 2 AND DAY(dia) >= 16)
      )
  `;

  db.query(query, [email, a, m, q, q], (err, results) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Error en la consulta de horas');
    }
    // Devolvemos el primer (y único) registro con las sumatorias
    res.json(results[0]);
  });
});

// ─── Guardar tarea (con múltiples contratos) ──────────────────────────────────
// Convierte nombre de contrato a sufijo de columna
// K2 → k2 | K10 → k10 | OTROS → otros
function sufijo(contrato) {
  return contrato.toLowerCase();
}

app.post('/guardar-tarea', (req, res) => {
  const {
    email,
    dia,
    provincia,
    moviles,
    operarios_cuil,
    contrato,          // string con contratos separados por coma: "K2,K6"
    contratos_data     // objeto: { K2: { tareas: 'T1,T2', horas: 4 }, K6: { tareas: 'T3', horas: 2 } }
  } = req.body;

  if (!email || !dia || !contrato) {
    return res.status(400).json({ error: 'Email, Fecha y al menos un contrato son obligatorios' });
  }

  // Definir estados iniciales según los contratos elegidos
  const arrContratos = contrato.split(',').map(c => c.trim().toUpperCase());
  const g1 = ['K2','K6','K12'];
  const g2 = ['K5','K8','K11'];
  const g3 = ['K9','K10','OTROS'];

  const aplicaG1 = arrContratos.some(c => g1.includes(c));
  const aplicaG2 = arrContratos.some(c => g2.includes(c));
  const aplicaG3 = arrContratos.some(c => g3.includes(c));

  // 1. Calcular las nuevas horas a insertar
  let nuevasHoras = 0;
  if (contratos_data && typeof contratos_data === 'object') {
    Object.values(contratos_data).forEach(v => {
      nuevasHoras += parseFloat(v.horas) || 0;
    });
  }

  // 2. Verificar duplicados y límite de horas
  const qVerificar = `
    SELECT 
      SUM(coalesce(horas_k2,0)+coalesce(horas_k5,0)+coalesce(horas_k6,0)+coalesce(horas_k8,0)+coalesce(horas_k9,0)+coalesce(horas_k10,0)+coalesce(horas_k11,0)+coalesce(horas_k12,0)+coalesce(horas_otros,0)) as total_dia,
      SUM(CASE WHEN contrato = ? THEN 1 ELSE 0 END) as duplicados
    FROM db_tareas_contratos 
    WHERE email = ? AND dia = ?
  `;
  
  db.query(qVerificar, [contrato, email, dia], (errV, resV) => {
    if (errV) return res.status(500).json({ error: 'Error verificando datos previos' });
    
    const horasPrevias = resV[0]?.total_dia || 0;
    const esDuplicado = resV[0]?.duplicados > 0;

    if (esDuplicado) {
      return res.status(400).json({ error: `Ya tenés un registro de ${contrato} en esta fecha. Eliminá el anterior o editálo.` });
    }

    if ((horasPrevias + nuevasHoras) > 24) {
      return res.status(400).json({ error: `Excediste el límite. Ya tenés ${horasPrevias}hs cargadas ese día e intentás cargar ${nuevasHoras}hs más.` });
    }

    // 3. Si todo está OK, procedemos a guardar
    const cols = ['marca_temporal', 'email', 'dia', 'provincia', 'moviles', 'operarios_cuil', 'contrato', 'estado_g1', 'estado_g2', 'estado_g3'];
    const vals = [
      new Date(), email, dia, provincia || null, moviles || null, operarios_cuil || '', contrato,
      aplicaG1 ? 'PENDIENTE' : 'NO APLICA',
      aplicaG2 ? 'PENDIENTE' : 'NO APLICA',
      aplicaG3 ? 'PENDIENTE' : 'NO APLICA'
    ];

  if (contratos_data && typeof contratos_data === 'object') {
    Object.entries(contratos_data).forEach(([k, v]) => {
      const s = sufijo(k);
      cols.push(`tareas_${s}`, `horas_${s}`);
      vals.push(v.tareas || '', parseFloat(v.horas) || 0);
    });
  }

  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT INTO db_tareas_contratos (${cols.join(', ')}) VALUES (${placeholders})`;

    db.query(sql, vals, (err, result) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Error al insertar tarea' });
      }
      if ((horasPrevias + nuevasHoras) > 11) {
        return res.json({ 
          alerta: true, 
          mensaje: `Guardado OK, pero tené en cuenta que cargaste un total de ${horasPrevias + nuevasHoras}hs para este día. Será revisado por Jefatura.` 
        });
      }
      res.json({ mensaje: 'Guardado OK', id: result.insertId });
    });
  }); // fin db.query qVerificar
});

// ─── Eliminar Tarea ──────────────────────────────────────────────────────────
app.delete('/eliminar-tarea/:id', (req, res) => {
  const { id } = req.params;
  const { email } = req.query;

  // Verificar que le pertenezca y no esté aprobado por nadie
  db.query('SELECT estado_g1, estado_g2, estado_g3 FROM db_tareas_contratos WHERE id = ? AND email = ?', [id, email], (err, rows) => {
    if (err || rows.length === 0) return res.status(404).json({ error: 'Tarea no encontrada o sin permiso' });

    const row = rows[0];
    if (row.estado_g1 === 'APROBADO' || row.estado_g2 === 'APROBADO' || row.estado_g3 === 'APROBADO') {
      return res.status(400).json({ error: 'No se puede eliminar una tarea que ya tiene horas aprobadas por jefatura' });
    }

    db.query('DELETE FROM db_tareas_contratos WHERE id = ?', [id], (err2) => {
      if (err2) return res.status(500).json({ error: 'Error al eliminar' });
      res.json({ mensaje: 'Tarea eliminada' });
    });
  });
});

// ─── Rutas de Jefatura ───────────────────────────────────────────────────────
app.get('/jefatura/pendientes', (req, res) => {
  const { email } = req.query;
  
  db.query('SELECT grupo FROM ma_jefes WHERE email = ? LIMIT 1', [email], (err, jefes) => {
    if (err || jefes.length === 0) return res.status(403).json({ error: 'No autorizado' });
    
    const grupo = jefes[0].grupo;
    const columnaEstado = `estado_g${grupo}`;
    
    const query = `
      SELECT t.id, t.dia, t.email AS operario_email, t.contrato, t.operarios_cuil,
        horas_k2, horas_k5, horas_k6, horas_k8, horas_k9, horas_k10, horas_k11, horas_k12, horas_otros,
        GROUP_CONCAT(DISTINCT e.apellido_nombre SEPARATOR ', ') AS operarios_nombres
      FROM db_tareas_contratos t
      LEFT JOIN snuempleados e ON e.cuil != '' AND FIND_IN_SET(e.cuil, t.operarios_cuil) > 0
      WHERE t.${columnaEstado} = 'PENDIENTE'
      GROUP BY t.id
      ORDER BY t.dia DESC
    `;
    
    db.query(query, (err2, results) => {
      if (err2) return res.status(500).json({ error: 'Error consultando pendientes' });
      res.json(results);
    });
  });
});

app.post('/jefatura/validar', (req, res) => {
  const { email, tarea_id, accion, horas_corregidas } = req.body; // accion: 'APROBADO' o 'RECHAZADO', horas_corregidas: { k2: 10, k6: 4 }
  
  db.query('SELECT grupo FROM ma_jefes WHERE email = ? LIMIT 1', [email], (err, jefes) => {
    if (err || jefes.length === 0) return res.status(403).json({ error: 'No autorizado' });
    
    const grupo = jefes[0].grupo;
    const colEstado = `estado_g${grupo}`;
    const colValidador = `validador_g${grupo}`;
    
    // Construir la consulta de UPDATE dinámicamente si hay horas_corregidas
    let setClause = `${colEstado} = ?, ${colValidador} = ?`;
    let vals = [accion, email];

    if (horas_corregidas && accion === 'APROBADO') {
      Object.entries(horas_corregidas).forEach(([k, v]) => {
        setClause += `, horas_${k.toLowerCase()} = ?`;
        vals.push(parseFloat(v) || 0);
      });
    }

    vals.push(tarea_id);
    const qUpdate = `UPDATE db_tareas_contratos SET ${setClause} WHERE id = ?`;
    
    db.query(qUpdate, vals, (err2) => {
      if (err2) return res.status(500).json({ error: 'Error actualizando tarea' });
      res.json({ mensaje: 'Actualizado correctamente' });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3001;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});