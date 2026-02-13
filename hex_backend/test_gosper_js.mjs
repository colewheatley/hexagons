// Quick test to verify JavaScript Gosper offsets match Python

function generateGosperOffsets(level) {
    if (level === 0) return [{ q: 0, r: 0 }];

    const prevOffsets = generateGosperOffsets(level - 1);

    const applyMatrixPower = (q, r, power) => {
        for (let i = 0; i < power; i++) {
            const nq = 2 * q + 1 * r;
            const nr = -1 * q + 3 * r;
            q = nq;
            r = nr;
        }
        return { q, r };
    };

    // MUST match Python exactly
    const neighbors = [
        { q: 0, r: 0 },
        { q: 1, r: 0 },
        { q: 1, r: -1 },
        { q: 0, r: -1 },
        { q: -1, r: 0 },
        { q: -1, r: 1 },
        { q: 0, r: 1 }
    ];

    const finalList = [];

    for (let i = 0; i < 7; i++) {
        const baseShift = neighbors[i];
        const shift = applyMatrixPower(baseShift.q, baseShift.r, level - 1);

        if (level === 5) {
            console.log(`Level ${level}, neighbor ${i}: base(${baseShift.q},${baseShift.r}) -> shift(${shift.q},${shift.r})`);
        }

        for (const p of prevOffsets) {
            finalList.push({
                q: p.q + shift.q,
                r: p.r + shift.r
            });
        }
    }

    return finalList;
}

console.log("=== JAVASCRIPT GOSPER OFFSET TEST ===\n");
const offsets = generateGosperOffsets(5);

console.log("\n=== JAVASCRIPT GOSPER OFFSET DEBUG ===");
console.log("First 7 offsets:", offsets.slice(0, 7).map(o => `(${o.q},${o.r})`).join(", "));
console.log("Offsets 2401-2407:", offsets.slice(2401, 2408).map(o => `(${o.q},${o.r})`).join(", "));
console.log("Last 7 offsets:", offsets.slice(-7).map(o => `(${o.q},${o.r})`).join(", "));
console.log("Total offsets:", offsets.length);
