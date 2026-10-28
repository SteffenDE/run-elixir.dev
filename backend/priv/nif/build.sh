mkdir -p "$APP"
cd "$SRC"
sh -eu /workspace/recipe.sh >&2
if [ ! -d "$APP/priv" ]; then
  echo "build.sh: the recipe left no $APP/priv" >&2
  exit 3
fi
tar -cf - -C "$APP" priv
