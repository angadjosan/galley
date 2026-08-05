# HTML blocks and code fences

CommonMark type 1 — a script/pre/style block:

<pre>
  raw   preformatted   text
</pre>

CommonMark type 2 — an HTML comment block:

<!-- a standalone comment block
     spanning two lines -->

CommonMark type 3 — a processing instruction:

<?php echo "hi"; ?>

CommonMark type 4 — a declaration:

<!DOCTYPE html>

CommonMark type 5 — CDATA:

<![CDATA[ raw <cdata> content ]]>

CommonMark type 6 — a known block tag:

<div class="block">
  <p>An HTML block with <em>markup</em> inside.</p>
</div>

CommonMark type 7 — any other complete tag on its own line:

<custom-element data-x="1">
  body
</custom-element>

An <span class="inline">inline html</span> element inside a paragraph.

A fence with four backticks holding a three-backtick fence:

````text
```
inner fence
```
````

A fence with five backticks:

`````md
````
nested four
````
`````

A fence with an info string carrying metadata:

```ts title="example.ts" {1,3-4}
export const x = 1;
```

A tilde fence holding backticks:

~~~text
``` not a fence here ```
~~~

An empty fence:

```
```

An indented code block:

    indented code line one
    indented code line two

A code span containing backticks: `` a ` b ``.
