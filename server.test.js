const mysql = require('mysql2');

const db = mysql.createConnection({
  host: '191.101.235.7',
  user: 'root_test',
  password: 'testing.Root#26',
  database: 'testing',
  port: 3306
});

db.connect((err) => {
  if (err) {
    console.error('Error:', err.message);
    console.error('Code:', err.code);
  } else {
    console.log('Conectado OK');
    db.end();
  }
});