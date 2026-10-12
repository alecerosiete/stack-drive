import { escapeQueryValue } from './drive.service';

describe('escapeQueryValue', () => {
  it('deja intactos los nombres normales', () => {
    expect(escapeQueryValue('informe anual.pdf')).toBe('informe anual.pdf');
  });

  it('escapa los apóstrofos, que delimitan los literales de la consulta', () => {
    // Sin escapar, `O'Brien.pdf` cerraría la cadena y rompería la query.
    expect(escapeQueryValue("O'Brien.pdf")).toBe("O\\'Brien.pdf");
  });

  it('escapa las barras invertidas antes que las comillas', () => {
    expect(escapeQueryValue('ruta\\archivo')).toBe('ruta\\\\archivo');
  });

  it('neutraliza un intento de inyectar cláusulas en la consulta', () => {
    const malicioso = "x' or '1'='1";

    const escapado = escapeQueryValue(malicioso);

    expect(escapado).toBe("x\\' or \\'1\\'=\\'1");
    expect(escapado).not.toMatch(/(^|[^\\])'/);
  });
});
