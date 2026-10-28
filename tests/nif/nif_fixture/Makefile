# elixir_make's targets; the playground's make answers them with the
# library the backend (in tests, its fixtures) built.
PRIV = $(MIX_APP_PATH)/priv

all: $(PRIV)/nif_fixture.so

$(PRIV)/nif_fixture.so: c_src/nif_fixture.cpp
	mkdir -p $(PRIV)
	$(CXX) $(CXXFLAGS) -I$(ERTS_INCLUDE_DIR) -shared c_src/nif_fixture.cpp -o $@

clean:
	rm -f $(PRIV)/nif_fixture.so
