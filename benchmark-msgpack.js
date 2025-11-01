// Performance benchmark: JSON vs MessagePack
import * as msgpack from '@msgpack/msgpack';

// Simulate typical state_delta message (10 coins)
const createStateDeltaMessage = () => {
  const updates = [];
  for (let i = 1; i <= 10; i++) {
    updates.push({
      id: i,
      pos: [
        Math.random() * 0.5,
        Math.random() * 1.5,
        Math.random() * 0.5,
      ],
      rot: [
        Math.random() * 0.1,
        Math.sqrt(1 - Math.random() * 0.01),
        Math.random() * 0.1,
        Math.sqrt(1 - Math.random() * 0.01),
      ],
    });
  }

  return {
    op: 'state_delta',
    serverTime: Date.now(),
    tick: 12345,
    updates,
    pusherZ: 0.148,
  };
};

// Simulate coin_insert message
const createCoinInsertMessage = () => ({
  op: 'coin_insert',
  x: 0.123,
});

// Simulate world_snapshot message
const createWorldSnapshotMessage = () => {
  const bodies = [
    { id: 0, type: 'pusher', z: 0.15 },
  ];
  
  for (let i = 1; i <= 10; i++) {
    bodies.push({
      id: i,
      type: 'coin',
      pos: [Math.random() * 0.5, 1.5, Math.random() * 0.5],
      rot: [0, 0.707, 0, 0.707],
    });
  }

  return {
    op: 'world_snapshot',
    protocolVersion: 1,
    serverTime: Date.now(),
    tick: 100,
    bodies,
  };
};

// Benchmark function
function benchmark(name, message, iterations = 10000) {
  console.log(`\n📊 Benchmarking: ${name}`);
  console.log(`   Iterations: ${iterations}`);
  console.log(`   Message type: ${message.op}`);

  // JSON
  const jsonStr = JSON.stringify(message);
  const jsonSize = Buffer.from(jsonStr, 'utf8').length;
  
  let jsonEncodeTime = 0;
  let jsonDecodeTime = 0;
  
  // Warm up
  for (let i = 0; i < 100; i++) {
    JSON.stringify(message);
    JSON.parse(jsonStr);
  }

  // JSON encode benchmark
  const jsonEncodeStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    JSON.stringify(message);
  }
  jsonEncodeTime = performance.now() - jsonEncodeStart;

  // JSON decode benchmark
  const jsonDecodeStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    JSON.parse(jsonStr);
  }
  jsonDecodeTime = performance.now() - jsonDecodeStart;

  // MessagePack
  const msgpackBinary = msgpack.encode(message);
  const msgpackSize = msgpackBinary.length;
  
  let msgpackEncodeTime = 0;
  let msgpackDecodeTime = 0;

  // Warm up
  for (let i = 0; i < 100; i++) {
    msgpack.encode(message);
    msgpack.decode(msgpackBinary);
  }

  // MessagePack encode benchmark
  const msgpackEncodeStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    msgpack.encode(message);
  }
  msgpackEncodeTime = performance.now() - msgpackEncodeStart;

  // MessagePack decode benchmark
  const msgpackDecodeStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    msgpack.decode(msgpackBinary);
  }
  msgpackDecodeTime = performance.now() - msgpackDecodeStart;

  // Results
  const sizeReduction = ((1 - msgpackSize / jsonSize) * 100).toFixed(1);
  const encodeSpeedup = (jsonEncodeTime / msgpackEncodeTime).toFixed(2);
  const decodeSpeedup = (jsonDecodeTime / msgpackDecodeTime).toFixed(2);

  console.log('\n   📏 Size Comparison:');
  console.log(`      JSON:        ${jsonSize} bytes`);
  console.log(`      MessagePack: ${msgpackSize} bytes`);
  console.log(`      Reduction:   ${sizeReduction}% ✅`);

  console.log('\n   ⚡ Encode Speed:');
  console.log(`      JSON:        ${(jsonEncodeTime / iterations).toFixed(3)} ms/op`);
  console.log(`      MessagePack: ${(msgpackEncodeTime / iterations).toFixed(3)} ms/op`);
  console.log(`      Speedup:     ${encodeSpeedup}x ✅`);

  console.log('\n   ⚡ Decode Speed:');
  console.log(`      JSON:        ${(jsonDecodeTime / iterations).toFixed(3)} ms/op`);
  console.log(`      MessagePack: ${(msgpackDecodeTime / iterations).toFixed(3)} ms/op`);
  console.log(`      Speedup:     ${decodeSpeedup}x ✅`);

  // Calculate bandwidth at 30Hz
  const jsonBandwidth = (jsonSize * 30 / 1024).toFixed(2);
  const msgpackBandwidth = (msgpackSize * 30 / 1024).toFixed(2);
  console.log('\n   📡 Bandwidth @ 30Hz:');
  console.log(`      JSON:        ${jsonBandwidth} KB/s`);
  console.log(`      MessagePack: ${msgpackBandwidth} KB/s`);
  console.log(`      Savings:     ${(parseFloat(jsonBandwidth) - parseFloat(msgpackBandwidth)).toFixed(2)} KB/s`);

  return {
    sizeReduction: parseFloat(sizeReduction),
    encodeSpeedup: parseFloat(encodeSpeedup),
    decodeSpeedup: parseFloat(decodeSpeedup),
  };
}

// Run benchmarks
console.log('🚀 MessagePack Performance Benchmark');
console.log('=====================================\n');

const results = [];

// Test 1: State Delta (most frequent message)
const stateDelta = createStateDeltaMessage();
results.push(benchmark('State Delta (10 coins)', stateDelta, 10000));

// Test 2: Coin Insert
const coinInsert = createCoinInsertMessage();
results.push(benchmark('Coin Insert', coinInsert, 100000));

// Test 3: World Snapshot
const worldSnapshot = createWorldSnapshotMessage();
results.push(benchmark('World Snapshot (10 coins + pusher)', worldSnapshot, 1000));

// Summary
console.log('\n\n📈 Summary');
console.log('==========');
const avgSizeReduction = (results.reduce((sum, r) => sum + r.sizeReduction, 0) / results.length).toFixed(1);
const avgEncodeSpeedup = (results.reduce((sum, r) => sum + r.encodeSpeedup, 0) / results.length).toFixed(2);
const avgDecodeSpeedup = (results.reduce((sum, r) => sum + r.decodeSpeedup, 0) / results.length).toFixed(2);

console.log(`Average Size Reduction: ${avgSizeReduction}%`);
console.log(`Average Encode Speedup:  ${avgEncodeSpeedup}x`);
console.log(`Average Decode Speedup:  ${avgDecodeSpeedup}x`);

console.log('\n✅ Benchmark Complete!\n');

