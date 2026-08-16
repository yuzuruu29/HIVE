# Contributing to The Hive Skill

First off, thank you for considering contributing to The Hive Skill! It's people like you that make open source such a great community.

## Where do I go from here?

If you've noticed a bug or have a feature request, please create an issue! It's generally best if you get confirmation of your bug or approval for your feature request this way before starting to code.

## Fork & create a branch

If this is something you think you can fix, then fork The Hive Skill and create a branch with a descriptive name.

## Get the test suite running

Make sure the tests pass before you commit any changes. We use GitHub Actions for our CI pipeline.

## Implement your fix or feature

At this point, you're ready to make your changes. Feel free to ask for help; everyone is a beginner at first.

## Make a Pull Request

At this point, you should switch back to your master branch and make sure it's up to date with The Hive Skill's master branch:

```bash
git remote add upstream https://github.com/yuzuruu29/the-hive-skill.git
git checkout master
git pull upstream master
```

Then update your feature branch from your local copy of master, and push it!

```bash
git checkout 325-add-japanese-translations
git rebase master
git push --set-upstream origin 325-add-japanese-translations
```

Finally, go to GitHub and make a Pull Request!
