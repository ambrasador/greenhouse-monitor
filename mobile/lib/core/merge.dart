/// Точка ряду: час у мілісекундах від епохи й значення.
class Point {
  const Point(this.t, this.v);

  final int t;
  final double v;

  @override
  bool operator ==(Object other) =>
      other is Point && other.t == t && other.v == v;

  @override
  int get hashCode => Object.hash(t, v);

  @override
  String toString() => 'Point($t, $v)';
}

/// Злиття двох рядів, відсортованих за `t`. Однаковий `t` — одна точка,
/// новіший ряд [b] перемагає. Якщо [b] нічого не змінив, повертається
/// той самий список [a]: порівняння `identical` дешеве, і екран, що
/// залежить від ряду, не перемальовується.
List<Point> mergeSorted(List<Point> a, List<Point> b, {int? max}) {
  final out = <Point>[];
  var i = 0;
  var j = 0;
  var changed = false;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i].t < b[j].t)) {
      out.add(a[i++]);
    } else if (i >= a.length || b[j].t < a[i].t) {
      out.add(b[j++]);
      changed = true; // нова точка
    } else {
      final same = a[i].v == b[j].v;
      out.add(same ? a[i] : b[j]);
      changed = changed || !same;
      i++;
      j++;
    }
  }
  final limit = max;
  if (!changed && (limit == null || out.length <= limit)) return a;
  if (limit != null && out.length > limit) {
    return out.sublist(out.length - limit);
  }
  return out;
}
