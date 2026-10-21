# Privacy

These plugins collect nothing for us. We run no server, and no data comes back to us.

checker, reviewers and writing-rules send nothing over the network. Their hooks read local files and
keep a small counter in the system temp folder.

lit-search sends search terms, paper identifiers and paper text to the services listed in its
[README](plugins/lit-search/README.md), each under its own privacy policy. If you set `LIT_SEARCH_EMAIL`,
that address goes to Unpaywall, which asks for it on every request. The result files and downloaded
papers stay on your machine: `litfind/` and `readswarm/` in the working directory, and a cache in the
system temp folder. The result files hold the author names of the papers found.

Questions: https://github.com/joverwiening/research-skills/issues
