/** Controlled artifact for runner/oracle tests, never a real model-quality observation. */
export const metricsSolution = `import json, sys

def single(r):
    net = None if r['gross'] is None or r['refunds'] is None else r['gross'] - r['refunds']
    return {'net': net, 'margin': None if net is None or r['cost'] is None else net - r['cost']}

def run(q):
    op = q['op']
    if op == 'single': return single(q['record'])
    if op == 'batch': return [single(r) for r in q['records']]
    if op == 'history': return {k: [single(r) for r in rs] for k, rs in q['series'].items()}
    nodes = ['gross', 'refunds', 'cost', 'net', 'margin']
    edges = [['gross', 'net'], ['refunds', 'net'], ['net', 'margin'], ['cost', 'margin']]
    if op == 'trace' and q['metric'] == 'net':
        nodes = ['gross', 'refunds', 'net']
        edges = edges[:2]
    result = {'nodes': nodes, 'edges': edges}
    if op == 'trace':
        values = {**q['record'], **single(q['record'])}
        result['values'] = {n: values[n] for n in nodes}
    return result

if __name__ == '__main__': print(json.dumps(run(json.load(sys.stdin))))
`;
export const metricsTests = `import unittest
from solution import run

class Regression(unittest.TestCase):
    def test_modes(self):
        series = {'north': [{'gross': 0, 'refunds': 0, 'cost': 0}],
                  'south': [{'gross': None, 'refunds': 1, 'cost': 2}],
                  'west': [{'gross': -2, 'refunds': 3, 'cost': 4}]}
        history = run({'op': 'history', 'series': series})
        self.assertEqual(set(history), set(series))
        expected = {'north': [{'net': 0, 'margin': 0}], 'south': [{'net': None, 'margin': None}], 'west': [{'net': -5, 'margin': -9}]}
        self.assertEqual(history, expected)
        for name, records in series.items():
            batch = run({'op': 'batch', 'records': records})
            self.assertEqual(batch, history[name])
            self.assertEqual(batch, [run({'op': 'single', 'record': r}) for r in records])
`;
