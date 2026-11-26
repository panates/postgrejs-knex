import { Writable } from 'node:stream';
import { expect } from 'expect';
import { type LiveDb, openLiveDb } from '../_support/live.js';

describe('live: streaming', function () {
  this.timeout(60000);
  let live: LiveDb;
  const t = 'live_stream.rows';

  before(async () => {
    live = await openLiveDb('live_stream');
    await live.db.raw(
      `create table ${t} as select g as id, 'row ' || g as name
       from generate_series(1, 1000) g`,
    );
  });
  after(async () => {
    await live?.close();
  });

  it('streams every row', async () => {
    const seen: any[] = [];
    await live
      .db(t)
      .orderBy('id')
      .stream(stream => {
        stream.on('data', row => seen.push(row));
      });
    expect(seen).toHaveLength(1000);
    expect(seen[0]).toEqual({ id: 1, name: 'row 1' });
    expect(seen.at(-1)).toEqual({ id: 1000, name: 'row 1000' });
  });

  it('streams in the batches it was asked for', async () => {
    // Knex's builder forwards one argument to the runner, so a call that
    // passes options and no handler answers the stream itself.
    const seen: any[] = [];
    for await (const row of live.db(t).orderBy('id').stream({ batchSize: 10 }))
      seen.push(row);
    expect(seen).toHaveLength(1000);
  });

  it('hands rows back as arrays when asked to', async () => {
    const seen: any[] = [];
    for await (const row of live
      .db(t)
      .orderBy('id')
      .limit(2)
      .stream({ rowMode: 'array' }))
      seen.push(row);
    expect(seen).toEqual([
      [1, 'row 1'],
      [2, 'row 2'],
    ]);
  });

  it('pipes into a writable', async () => {
    const seen: any[] = [];
    const sink = new Writable({
      objectMode: true,
      write(chunk, _encoding, callback) {
        seen.push(chunk);
        callback();
      },
    });
    await new Promise<void>((resolve, reject) => {
      sink.on('finish', resolve);
      sink.on('error', reject);
      live.db(t).orderBy('id').limit(5).pipe(sink);
    });
    expect(seen).toHaveLength(5);
  });

  it('stops, and leaves the connection usable, when the consumer breaks off', async () => {
    const stream = live.db(t).orderBy('id').stream({ batchSize: 10 });
    const seen: any[] = [];
    for await (const row of stream) {
      seen.push(row);
      if (seen.length === 3) break;
    }
    expect(seen).toHaveLength(3);
    // The cursor and its connection went back to the pool rather than
    // staying open mid-result, so the pool still answers.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await live.db(t).count('* as c')).toEqual([{ c: 1000 }]);
  });

  it('reports a server error on the stream', async () => {
    const error = await new Promise<any>(resolve => {
      live.db
        .raw('select * from live_stream.nope')
        .stream(stream => {
          stream.on('error', resolve);
        })
        .catch(resolve);
    });
    expect(error.code).toBe('42P01');
  });

  it('leaves a stream error undecorated when asked to', async () => {
    const { openKnex } = await import('../_support/live.js');
    const db = openKnex({ normalizeErrors: false });
    try {
      const error = await new Promise<any>(resolve => {
        db.raw('select * from live_stream.nope')
          .stream(stream => {
            stream.on('error', resolve);
          })
          .catch(resolve);
      });
      expect(error.code).toBe('42P01');
      // PostgreJS's own text, caret diagram and all, rather than pg's.
      expect(error.message.split('\n').length).toBeGreaterThan(1);
    } finally {
      await db.destroy();
    }
  });

  it('streams a result far larger than the batch size', async () => {
    let count = 0;
    for await (const row of live.db
      .raw('select g from generate_series(1, 50000) g')
      .stream({ batchSize: 500 }))
      if (row) count++;
    expect(count).toBe(50000);
  });
});
