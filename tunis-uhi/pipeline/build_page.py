"""Wrap src/page.html (the page body, also published as a Claude artifact) into a standalone index.html."""
import os
here = os.path.dirname(os.path.abspath(__file__))
body = open(os.path.join(here, "..", "src", "page.html"), encoding="utf-8").read()
html = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        '</head>\n<body>\n' + body + '</body>\n</html>\n')
open(os.path.join(here, "..", "index.html"), "w", encoding="utf-8").write(html)
print("wrote index.html")
