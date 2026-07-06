name: Fix thumb_url
on:
  workflow_dispatch: {}
permissions:
  contents: write
jobs:
  fix-thumb-urls:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout data branch
        uses: actions/checkout@v5
        with:
          ref: data
          fetch-depth: 0
      - name: Fetch main branch
        run: git fetch origin main --depth=1
      - name: Fetch fix script from main
        run: git show origin/main:fix-thumb-urls.js > fix-thumb-urls.js
      - name: Setup Node
        uses: actions/setup-node@v5
        with:
          node-version: '24'
      - name: Run fix script
        run: node fix-thumb-urls.js .
      - name: Cleanup temp script
        run: rm -f fix-thumb-urls.js
      - name: Commit & push if changed
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          if git diff --quiet; then
            echo "No changes."
          else
            git add -A
            git commit -m "fix: normalize expiring thumb_url links"
            git push origin data
          fi
