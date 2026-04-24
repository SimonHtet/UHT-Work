// Mock data for local testing without a real MSSQL connection.
// Used when MOCK_MODE=true in .env

const today = new Date().toISOString().split('T')[0];

const mockOperators = [
  { id: 1, username: 'simon',     password: '1234', machine_name: 'M1' },
  { id: 2, username: 'operator2', password: '1234', machine_name: 'M2' },
];

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
    row[`depositing ${i}`] = i <= 5 ? `DEP00${i}` : '';
    row[`OPT${i}`]         = i <= 5 ? i : null;
    row[`Supplier${i}`]    = i <= 5 ? 10 + i : null;
  }
  return row;
})();

module.exports = { mockOperators, mockProducts, mockMachineStatus };
