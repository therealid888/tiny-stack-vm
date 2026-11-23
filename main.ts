import fs from "node:fs";
import path from "node:path";

const IN = process.env.MAKEFUN_INPUT_DIR || "/input";
const OUT = process.env.MAKEFUN_OUTPUT_DIR || "/output";

// Tiny stack VM, ISA v1. Values are signed 32-bit; JS bitwise ops keep them so.
function run(prog, input) {
  const st = new Int32Array(256), cs = new Int32Array(64), mem = new Int32Array(256);
  const out = Buffer.alloc(65536);
  let n = 0, cn = 0, pc = 0, steps = 0, olen = 0, ip = 0;
  const L = prog.length;
  const done = (code) => ({ code, out: out.subarray(0, olen) });
  while (1) {
    if (steps >= 1000000) return done(10);
    if (pc < 0 || pc >= L) return done(9);
    const op = prog[pc];
    let a, b, v, s;
    switch (op) {
      case 0x00: return done(0); // HALT
      case 0x01: // PUSH8, sign-extended
        if (pc + 1 >= L) return done(9);
        if (n >= 256) return done(3);
        st[n++] = (prog[pc + 1] << 24) >> 24; pc += 2; break;
      case 0x02: // PUSH32, signed LE
        if (pc + 4 >= L) return done(9);
        if (n >= 256) return done(3);
        st[n++] = prog[pc + 1] | (prog[pc + 2] << 8) | (prog[pc + 3] << 16) | (prog[pc + 4] << 24); pc += 5; break;
      case 0x03: // POP
        if (n < 1) return done(2);
        n--; pc++; break;
      case 0x04: // DUP
        if (n < 1) return done(2);
        if (n >= 256) return done(3);
        st[n] = st[n - 1]; n++; pc++; break;
      case 0x05: // SWAP
        if (n < 2) return done(2);
        v = st[n - 1]; st[n - 1] = st[n - 2]; st[n - 2] = v; pc++; break;
      case 0x06: // OVER
        if (n < 2) return done(2);
        if (n >= 256) return done(3);
        st[n] = st[n - 2]; n++; pc++; break;
      case 0x07: // ROT ( a b c -- b c a )
        if (n < 3) return done(2);
        a = st[n - 3]; b = st[n - 2]; v = st[n - 1];
        st[n - 3] = b; st[n - 2] = v; st[n - 1] = a; pc++; break;
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16:
      case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d: case 0x1e:
      case 0x20: case 0x21: case 0x22: // binary ops: pop b (top), then a
        if (n < 2) return done(2);
        b = st[--n]; a = st[--n];
        switch (op) {
          case 0x10: v = (a + b) | 0; break; // ADD wraps
          case 0x11: v = (a - b) | 0; break; // SUB wraps
          case 0x12: v = Math.imul(a, b); break; // MUL low 32 bits
          case 0x13: if (b === 0) return done(4); v = (a / b) | 0; break; // DIV truncates; INT_MIN/-1 wraps
          case 0x14: if (b === 0) return done(4); v = (a % b) | 0; break; // MOD sign of a; x%-1 is 0
          case 0x15: if (b === 0) return done(4); v = ((a >>> 0) / (b >>> 0)) | 0; break; // DIVU unsigned
          case 0x16: if (b === 0) return done(4); v = ((a >>> 0) % (b >>> 0)) | 0; break; // MODU unsigned
          case 0x18: v = a & b; break;
          case 0x19: v = a | b; break;
          case 0x1a: v = a ^ b; break;
          case 0x1c: v = a << (b & 31); break; // SHL, low 5 bits of count
          case 0x1d: v = a >> (b & 31); break; // SHR arithmetic
          case 0x1e: v = (a >>> (b & 31)) | 0; break; // SHRU logical
          case 0x20: v = a === b ? 1 : 0; break; // EQ
          case 0x21: v = a < b ? 1 : 0; break; // LT signed
          case 0x22: v = (a >>> 0) < (b >>> 0) ? 1 : 0; break; // LTU unsigned
        }
        st[n++] = v; pc++; break;
      case 0x17: // NEG wraps
        if (n < 1) return done(2);
        st[n - 1] = (-st[n - 1]) | 0; pc++; break;
      case 0x1b: // NOT
        if (n < 1) return done(2);
        st[n - 1] = ~st[n - 1]; pc++; break;
      case 0x30: case 0x31: case 0x32: // jumps, 2-byte signed offset from next instruction
        if (pc + 2 >= L) return done(9);
        v = ((prog[pc + 1] | (prog[pc + 2] << 8)) << 16) >> 16;
        if (op === 0x30) { pc += 3 + v; break; }
        if (n < 1) return done(2); // JZ/JNZ pop either way
        a = st[--n];
        pc = (op === 0x31 ? a === 0 : a !== 0) ? pc + 3 + v : pc + 3; break;
      case 0x33: // CALL, 2-byte unsigned target
        if (pc + 2 >= L) return done(9);
        if (cn >= 64) return done(7);
        cs[cn++] = pc + 3; pc = prog[pc + 1] | (prog[pc + 2] << 8); break;
      case 0x34: // RET
        if (cn === 0) return done(8);
        pc = cs[--cn]; break;
      case 0x40: // LOAD ( addr -- v )
        if (n < 1) return done(2);
        a = st[n - 1];
        if (a < 0 || a > 255) return done(6);
        st[n - 1] = mem[a]; pc++; break;
      case 0x41: // STORE ( v addr -- ), top is addr
        if (n < 2) return done(2);
        a = st[--n]; v = st[--n];
        if (a < 0 || a > 255) return done(6);
        mem[a] = v; pc++; break;
      case 0x50: // PRINT decimal ASCII, no newline
        if (n < 1) return done(2);
        v = st[--n];
        s = String(v);
        if (olen + s.length > 65536) return done(11);
        out.write(s, olen); olen += s.length; pc++; break;
      case 0x51: // PUTC one byte
        if (n < 1) return done(2);
        if (olen >= 65536) return done(11);
        out[olen++] = st[--n] & 255; pc++; break;
      case 0x52: // IN, -1 once input is used up
        if (n >= 256) return done(3);
        st[n++] = ip < input.length ? input[ip++] : -1; pc++; break;
      case 0x53: // EXIT, low byte of v
        if (n < 1) return done(2);
        return done(st[--n] & 255);
      default: return done(5); // unknown opcode
    }
    steps++;
  }
}

// Driver: run every instance in the input dir, write stdout.bin + exit.txt.
for (const id of fs.readdirSync(IN).sort()) {
  const dir = path.join(IN, id);
  if (!fs.statSync(dir).isDirectory()) continue;
  const prog = fs.readFileSync(path.join(dir, "program.bin"));
  let input;
  try { input = fs.readFileSync(path.join(dir, "input.bin")); } catch { input = Buffer.alloc(0); }
  const r = run(prog, input);
  const od = path.join(OUT, id);
  fs.mkdirSync(od, { recursive: true });
  fs.writeFileSync(path.join(od, "stdout.bin"), r.out);
  fs.writeFileSync(path.join(od, "exit.txt"), r.code + "\n");
}
