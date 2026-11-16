// Static circuit facts keyed by OpenF1 circuit_key.
// lat/lon feed the weather forecast; length is the lap length in km.
export const CIRCUITS = {
  63: { name: 'Bahrain International Circuit', lat: 26.0325, lon: 50.5106, length: 5.412 },
  10: { name: 'Albert Park', lat: -37.8497, lon: 144.968, length: 5.278 },
  49: { name: 'Shanghai International Circuit', lat: 31.3389, lon: 121.2197, length: 5.451 },
  46: { name: 'Suzuka', lat: 34.8431, lon: 136.5407, length: 5.807 },
  149: { name: 'Jeddah Corniche Circuit', lat: 21.6319, lon: 39.1044, length: 6.174 },
  151: { name: 'Miami International Autodrome', lat: 25.9581, lon: -80.2389, length: 5.412 },
  23: { name: 'Circuit Gilles Villeneuve', lat: 45.5, lon: -73.5228, length: 4.361 },
  22: { name: 'Circuit de Monaco', lat: 43.7347, lon: 7.4206, length: 3.337 },
  15: { name: 'Circuit de Barcelona-Catalunya', lat: 41.57, lon: 2.2611, length: 4.657 },
  19: { name: 'Red Bull Ring', lat: 47.2197, lon: 14.7647, length: 4.318 },
  2: { name: 'Silverstone', lat: 52.0786, lon: -1.0169, length: 5.891 },
  7: { name: 'Spa-Francorchamps', lat: 50.4372, lon: 5.9714, length: 7.004 },
  4: { name: 'Hungaroring', lat: 47.5789, lon: 19.2486, length: 4.381 },
  55: { name: 'Zandvoort', lat: 52.3888, lon: 4.5409, length: 4.259 },
  39: { name: 'Monza', lat: 45.6156, lon: 9.2811, length: 5.793 },
  153: { name: 'Madring', lat: 40.4637, lon: -3.6158, length: 5.47 },
  144: { name: 'Baku City Circuit', lat: 40.3725, lon: 49.8533, length: 6.003 },
  12: { name: 'Sepang International Circuit', lat: 2.7608, lon: 101.7382, length: 5.543 },
  61: { name: 'Marina Bay Street Circuit', lat: 1.2914, lon: 103.864, length: 4.94 },
  9: { name: 'Circuit of the Americas', lat: 30.1328, lon: -97.6411, length: 5.513 },
  65: { name: 'Autódromo Hermanos Rodríguez', lat: 19.4042, lon: -99.0907, length: 4.304 },
  14: { name: 'Interlagos', lat: -23.7036, lon: -46.6997, length: 4.309 },
  152: { name: 'Las Vegas Strip Circuit', lat: 36.1147, lon: -115.1728, length: 6.201 },
  150: { name: 'Lusail International Circuit', lat: 25.49, lon: 51.4542, length: 5.419 },
  70: { name: 'Yas Marina Circuit', lat: 24.4672, lon: 54.6031, length: 5.281 },
};

/** Fallback: geocode a city with Open-Meteo when a circuit isn't in the table. */
export async function locate(circuitKey, location, countryName) {
  if (CIRCUITS[circuitKey]) return CIRCUITS[circuitKey];
  try {
    const q = encodeURIComponent(location);
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${q}&count=5`);
    const data = await res.json();
    const hit = (data.results || []).find((r) => r.country === countryName) || (data.results || [])[0];
    const lat = Number(hit?.latitude);
    const lon = Number(hit?.longitude);
    if (hit && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { name: location, lat, lon, length: null };
  } catch { /* ignore */ }
  return null;
}
