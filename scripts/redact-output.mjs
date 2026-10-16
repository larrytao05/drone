export function createRedactingWriter(secret, write) {
  const secrets = [secret, encodeURIComponent(secret)].filter(Boolean);
  let pending = '';

  return (chunk, final = false) => {
    pending += chunk;
    if (final) {
      const output = secrets.reduce((value, item) => value.replaceAll(item, '[redacted]'), pending);
      pending = '';
      if (output) write(output);
      return;
    }
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    const output = lines.map((line) => secrets.reduce((value, item) => value.replaceAll(item, '[redacted]'), line));
    if (output.length > 0) write(`${output.join('\n')}\n`);
  };
}
