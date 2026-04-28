// Mock data for local testing without a real MSSQL connection.
// Used when MOCK_MODE=true in .env

const today = new Date().toISOString().split('T')[0];

const MACHINES = [
  'A1','A3','A5','B1','B2','B3','C1','D1','D2','D3',
  'F1','F2','F3','F4','G1','G2','G3','H1','H2','H3',
  'I1','I2','K1','K2','M1','M2','M3',
];

// username = password = machine_name for every operator
const mockOperators = MACHINES.map((m, i) => ({
  id: i + 1,
  username: m,
  password: m,
  machine_name: m,
}));

const mockProducts = [
  { Product_ID: 'P001', Flavor: 'Chocolate',  Machine: 'M1' },
  { Product_ID: 'P002', Flavor: 'Strawberry', Machine: 'M1' },
  { Product_ID: 'P003', Flavor: 'Vanilla',    Machine: 'M2' },
];

// Simulates a row partially filled by Budibase: M1/P001/today, briks 1-5 filled
const mockMachineStatus = (() => {
  const row = {
    id: 1,
    'Product Date': today,
    Product_ID: 'P001',
    Machine: 'M1',
    Flavor: 'Chocolate',
  };
  for (let i = 1; i <= 40; i++) {
    row[`Barcode ${i}`]    = i <= 5 ? `BC00${i}` : '';
    row[`depositing ${i}`] = i <= 5 ? 'L' : '';
    row[`OPT${i}`]         = i <= 5 ? i : null;
    row[`Supplier${i}`]    = i <= 5 ? 10 + i : null;
  }
  return row;
})();

module.exports = { mockOperators, mockProducts, mockMachineStatus };
