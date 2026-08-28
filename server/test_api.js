const axios = require('axios');

async function test() {
  const url = `https://stockwave-api-v2.onrender.com/api/quotes?symbols=NVDA,TSLA`;
  try {
    console.log("Fetching...");
    const res = await axios.get(url, { timeout: 10000 });
    console.log("Status:", res.status);
    console.log("Data:", JSON.stringify(res.data, null, 2));
  } catch (e) {
    console.error("Error:", e.message);
  }
}
test();
