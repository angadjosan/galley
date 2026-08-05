# Tables, references and links

A table with escaped pipes and empty cells:

| left \| pipe | middle | right |
| --- | --- | --- |
| a | | c |
| | b | |
| `code \| span` | x | |

An unpadded table with every alignment:

|left|centre|right|
|:---|:---:|---:|
|1|2|3|

A single-column table:

| only |
| --- |
| one |

Reference links: see [the spec][spec], [the guide][], and [shortcut].
A reference image: ![a diagram][diagram].

Collapsed and full reference forms both round trip.

Autolinks: <https://example.com/path?a=1&b=2> and <mailto:someone@example.com>.

Entity references: &amp; &copy; &nbsp; &#35; &#x2603; and a bare & ampersand.

Links with awkward targets: [parens](https://example.com/a(b)),
[angle target](<https://example.com/a b>), and [titled](https://example.com "A Title").

A footnote reference[^note] and a second one[^another].

[spec]: https://example.com/spec "The Spec"
[the guide]: https://example.com/guide
[shortcut]: https://example.com/shortcut
[diagram]: https://example.com/diagram.png "A Diagram"

[^note]: A footnote body on one line.
[^another]: Another footnote body.
