package app

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// This source census is a build-time safety assertion, never a runtime SQL
// classifier. It catches new direct generated writes and raw transaction seams
// that would evade request commit admission. Service-owned RP/provider/directory
// transactions have independent source-boundary tests and are deliberately separate.
func TestIdentityMutationQueryAndPoolInventory(t *testing.T) {
	root := ".."
	generated, err := filepath.Glob(filepath.Join(root, "db/sqlc/*.sql.go"))
	if err != nil {
		t.Fatal(err)
	}
	mutations := map[string]bool{}
	write := regexp.MustCompile(`\b(?:INSERT|UPDATE|DELETE)\b`)
	comments := regexp.MustCompile(`(?m)--[^\n]*`)
	for _, name := range generated {
		f, err := parser.ParseFile(token.NewFileSet(), name, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		constants := map[string]string{}
		for _, decl := range f.Decls {
			if g, ok := decl.(*ast.GenDecl); ok {
				for _, spec := range g.Specs {
					if value, ok := spec.(*ast.ValueSpec); ok && len(value.Values) == 1 {
						if lit, ok := value.Values[0].(*ast.BasicLit); ok {
							raw, _ := strconv.Unquote(lit.Value)
							constants[value.Names[0].Name] = raw
						}
					}
				}
			}
		}
		for _, decl := range f.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Recv == nil {
				continue
			}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok || len(call.Args) < 2 {
					return true
				}
				selector, ok := call.Fun.(*ast.SelectorExpr)
				if !ok || selector.Sel.Name != "Exec" && selector.Sel.Name != "Query" && selector.Sel.Name != "QueryRow" {
					return true
				}
				id, ok := call.Args[1].(*ast.Ident)
				if ok && write.MatchString(comments.ReplaceAllString(constants[id.Name], "")) {
					mutations[fn.Name.Name] = true
				}
				return true
			})
		}
	}
	if len(mutations) < 400 {
		t.Fatalf("generated query census unexpectedly incomplete: %d", len(mutations))
	}
	files := 0
	err = filepath.WalkDir(root, func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			switch filepath.Base(name) {
			case "db", "gateway", "sso", "oauthprovider", "directory":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			return nil
		}
		files++
		positions := token.NewFileSet()
		f, err := parser.ParseFile(positions, name, nil, 0)
		if err != nil {
			return err
		}
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if ok {
				if field, ok := selector.X.(*ast.SelectorExpr); ok && field.Sel.Name == "Q" && mutations[selector.Sel.Name] {
					t.Errorf("direct mutation evades admission: %s %s", positions.Position(call.Pos()), selector.Sel.Name)
				}
				if field, ok := selector.X.(*ast.SelectorExpr); ok && field.Sel.Name == "Pool" {
					t.Errorf("direct Pool operation evades admission: %s %s", positions.Position(call.Pos()), selector.Sel.Name)
				}
				if pkg, ok := selector.X.(*ast.Ident); ok && pkg.Name == "pgx" && strings.HasPrefix(selector.Sel.Name, "Begin") {
					t.Errorf("raw transaction evades admission: %s", positions.Position(call.Pos()))
				}
			}
			// Existing board SQL loaders accept a DBTX for reads. All dynamic writes
			// instead receive the raw transaction from DB.TxRaw, never the Pool.
			for _, arg := range call.Args {
				if field, ok := arg.(*ast.SelectorExpr); ok && field.Sel.Name == "Pool" {
					if sel, ok := call.Fun.(*ast.SelectorExpr); ok {
						if pkg, ok := sel.X.(*ast.Ident); ok && pkg.Name == "health" && sel.Sel.Name == "Routes" && filepath.Base(filepath.Dir(name)) == "app" {
							continue
						}
						if pkg, ok := sel.X.(*ast.Ident); ok && pkg.Name == "boards" && sel.Sel.Name == "OpenTasksOf" && filepath.Base(filepath.Dir(name)) == "workspaces" {
							continue
						}
						if sel.Sel.Name == "loadTask" && filepath.Base(filepath.Dir(name)) == "boards" {
							if last, ok := call.Args[len(call.Args)-1].(*ast.Ident); ok && last.Name == "false" {
								continue
							}
						}
					}
					id, ok := call.Fun.(*ast.Ident)
					if !ok || filepath.Base(filepath.Dir(name)) != "boards" || id.Name != "queryTasks" && id.Name != "loadTask" && id.Name != "taskByID" && id.Name != "searchTasks" {
						t.Errorf("unclassified raw Pool consumer: %s", positions.Position(call.Pos()))
					}
				}
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if files < 100 {
		t.Fatalf("consumer inventory unexpectedly incomplete: %d", files)
	}
	t.Logf("audited %d existing consumer source files against %d generated mutation/locking methods", files, len(mutations))
}
