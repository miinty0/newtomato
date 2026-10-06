"""Run with: python3 -m unittest discover -s tests -v (requires Node.js)."""
import json
from html.parser import HTMLParser
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]
RENDER = r"""
const fs = require('node:fs');
const vm = require('node:vm');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const source = fs.readFileSync('index.html', 'utf8');
// Compile the entire inline application, then run the production card helpers
// without invoking configuration or network requests.
new vm.Script(source.split('<script>')[1].split('</script>')[0]);
const start = source.indexOf('// Formatting helpers');
const end = source.indexOf('// DAILY TAB', start);
const idStart = source.indexOf('function normalizedBookId');
const idEnd = source.indexOf('function scoreBadgeBookId', idStart);
const context = vm.createContext({
  automaticReadHidden: new Set(),
  scoreCache: new Map(input.scores || []),
  pendingRead: { [input.tab]: new Set(input.pending || []) }
});
vm.runInContext(source.slice(idStart, idEnd) + source.slice(start, end), context);
const cards = input.books.map(book =>
  context.bookCardHTML(book, input.tab, new Set(input.read || [])));
process.stdout.write('<div id="books" class="books-grid">' + cards.join('') + '</div>');
"""


class Tree(HTMLParser):
    VOID = {'img', 'br', 'hr', 'input', 'meta', 'link'}

    def __init__(self, markup):
        super().__init__(convert_charrefs=True)
        self.root = {'tag': 'root', 'attrs': {}, 'children': []}
        self.stack = [self.root]
        self.errors = []
        self.feed(markup)
        if len(self.stack) != 1:
            self.errors.append('Unclosed tags')

    def handle_starttag(self, tag, attrs):
        node = {'tag': tag, 'attrs': dict(attrs), 'children': []}
        self.stack[-1]['children'].append(node)
        if tag not in self.VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if len(self.stack) == 1 or self.stack[-1]['tag'] != tag:
            self.errors.append('Unexpected closing tag: ' + tag)
        else:
            self.stack.pop()

    def handle_data(self, data):
        self.stack[-1]['children'].append(data)


def nodes(node):
    yield node
    for child in node['children']:
        if isinstance(child, dict):
            yield from nodes(child)


def text(node):
    return ''.join(text(c) if isinstance(c, dict) else c for c in node['children'])


def by_class(node, name):
    return [n for n in nodes(node) if name in n['attrs'].get('class', '').split()]


def render(books, tab='rankcat', **options):
    result = subprocess.run(['node', '-e', RENDER], cwd=ROOT,
                            input=json.dumps({'books': books, 'tab': tab, **options}),
                            text=True, capture_output=True, check=True)
    return Tree(result.stdout)


class BookCardLayoutTests(unittest.TestCase):
    def assert_flat(self, tree, count):
        self.assertEqual(tree.errors, [])
        grid = tree.root['children'][0]
        direct = [n for n in grid['children'] if isinstance(n, dict)]
        self.assertEqual(len(direct), count)
        self.assertEqual(len(by_class(grid, 'book-card')), count)
        self.assertTrue(all('book-card' in n['attrs']['class'] for n in direct))
        return direct

    def test_real_emoticon_does_not_nest_following_cards_in_any_tab(self):
        # Actual offending abstract in rank_cat_24.json, book 7666828871085345817.
        abstract = '男主无三观，是非常的强制爱（雷者自躲o>_<o）\n全文以第一人称为主'
        books = [{'book_id': str(7666828871085345817 + i), 'book_name': '深陷阴湿黑泥中',
                  'abstract': abstract if i == 0 else '下一本', 'tags': []} for i in range(200)]
        for tab in ['daily', 'category', 'rankcat', 'special']:
            with self.subTest(tab=tab):
                cards = self.assert_flat(render(books, tab), 200)
                self.assertEqual(text(by_class(cards[0], 'book-abstract')[0]), abstract)

    def test_all_metadata_and_quoted_attributes_remain_literal_text(self):
        value = '\"><div id="rankcat-books"> &amp; <img src=x> \' o>_<o'
        book = {'book_id': '123', 'book_name': value, 'author': value, 'abstract': value,
                'tags': [value], 'thumb_url': 'https://example.com/a?x="y"&z=1',
                'currentPos': value, 'rankMold': 1, '_specialSources': [value]}
        card = self.assert_flat(render([book, {'book_id': '124'}], 'special',
                                      scores=[['123', value]]), 2)[0]
        for name in ['book-name', 'book-author', 'book-abstract']:
            self.assertEqual(text(by_class(card, name)[0]), value)
        self.assertEqual(by_class(card, 'book-name')[0]['attrs']['title'], value)
        self.assertEqual(card['attrs']['data-name'], value.lower())
        self.assertEqual([text(n) for n in by_class(card, 'tag')], [value, value])
        self.assertEqual(text(by_class(card, 'score-badge')[0]), '⭐' + value)
        self.assertEqual(len([n for n in nodes(card) if n['tag'] == 'img']), 1)
        self.assertEqual(by_class(card, 'book-thumb')[0]['attrs']['src'], book['thumb_url'])

    def test_inline_handlers_preserve_ids_and_tabs_after_html_parsing(self):
        book_id = '123\'"<&\\\n'
        card = self.assert_flat(render([{'book_id': book_id, 'abstract': '简介'}]), 1)[0]
        handlers = [n['attrs']['onclick'] for n in nodes(card) if 'onclick' in n['attrs']]
        script = r"""
const vm = require('node:vm');
const calls = [];
const ctx = { toggleRead: (...args) => calls.push(args.filter(x => typeof x === 'string')),
              openAbstract: (...args) => calls.push(args.filter(x => typeof x === 'string')) };
for (const handler of JSON.parse(require('node:fs').readFileSync(0, 'utf8'))) vm.runInNewContext(handler, ctx);
process.stdout.write(JSON.stringify(calls));
"""
        result = subprocess.run(['node', '-e', script], input=json.dumps(handlers),
                                text=True, capture_output=True, check=True)
        self.assertEqual(json.loads(result.stdout), [[book_id.strip()], [book_id.strip(), 'rankcat']])

    def test_read_state_score_and_cover_fallback_are_preserved(self):
        books = [{'book_id': str(i), 'status': 'Completed', 'rankMold': 1,
                  'thumb_url': 'https://example.com/cover', 'abstract': '简介'} for i in range(1, 4)]
        cards = self.assert_flat(render(books, read=['1'], pending=['2'], scores=[['3', 9.9]]), 3)
        self.assertIn('is-read', cards[0]['attrs']['class'])
        self.assertIn('disabled', by_class(cards[0], 'btn-read')[0]['attrs'])
        self.assertIn('marked', by_class(cards[1], 'btn-read')[0]['attrs']['class'])
        self.assertEqual(text(by_class(cards[2], 'score-badge')[0]), '⭐9.9')
        self.assertEqual(text(by_class(cards[2], 'completed')[0]), 'Hoàn thành')
        self.assertIn('nextElementSibling', by_class(cards[2], 'book-thumb')[0]['attrs']['onerror'])


if __name__ == '__main__':
    unittest.main()
